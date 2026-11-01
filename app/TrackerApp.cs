using System;
using System.IO;
using System.Net.Http;
using System.Web.Script.Serialization;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Xml;
using Forms = System.Windows.Forms;

namespace ArmsRaceTracker {
  static class Native {
    [DllImport("user32.dll")] internal static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] internal static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] internal static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongW")] internal static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] internal static extern bool DestroyIcon(IntPtr icon);
  }

  sealed class TrackerUi {
    readonly string root;
    readonly Translations translations;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly HttpClient client = new HttpClient();
    readonly Window main;
    readonly Window hud;
    readonly DispatcherTimer timer = new DispatcherTimer();
    Forms.NotifyIcon tray;
    HwndSource hotkeySource;
    bool busy, locked, exiting, backendStarting;
    string historyFingerprint = "";
    int port = 37651;
    string expectedSteamid = "";
    IntPtr mainHandle;
    bool hotkeyH, hotkeyL;
    object lastSummary;
    bool startWithHud;

    static object Value(object source, string key) {
      var dictionary = source as Dictionary<string, object>;
      object value;
      return dictionary != null && dictionary.TryGetValue(key, out value) ? value : null;
    }
    static string Text(object source, string key, string fallback = "") {
      object value = Value(source, key);
      return value == null ? fallback : Convert.ToString(value, CultureInfo.InvariantCulture);
    }
    static int Number(object source, string key) {
      int number;
      return int.TryParse(Text(source, key), out number) ? number : 0;
    }
    string T(string key, params object[] args) { return translations.Get(key,args); }
    string MapName(string map) {
      if (string.IsNullOrEmpty(map)) return T("mainMenu");
      switch (map) {
        case "ar_baggage": return "Baggage";
        case "ar_pool_day": return "Pool Day";
        case "ar_shoots": return T("mapShoots");
        case "ar_shoots_night": return T("mapShootsNight");
        default: return map.Replace("ar_", "").Replace('_', ' ');
      }
    }
    string LocalTime(string value, string format) {
      DateTimeOffset time;
      return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out time)
        ? time.ToLocalTime().ToString(T(format), translations.Culture) : "";
    }
    static Brush Brush(string value) { return (Brush)new BrushConverter().ConvertFromString(value); }
    TextBlock Label(Window window, string name) { return (TextBlock)window.FindName(name); }
    void Set(Window window, string name, string value) { Label(window, name).Text = value; }
    void Click(Window window, string name, RoutedEventHandler action) { ((Button)window.FindName(name)).Click += action; }
    Window Load(string filename) {
      Window window;
      using (var reader = XmlReader.Create(Path.Combine(root, "app", filename))) window = (Window)XamlReader.Load(reader);
      using (var reader = XmlReader.Create(Path.Combine(root, "app", "Theme.xaml"))) window.Resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Load(reader));
      return window;
    }

    public TrackerUi(string directory) {
      root = directory;
      translations = new Translations(root);
      client.Timeout = TimeSpan.FromMilliseconds(900);
      var settingsPath = Path.Combine(root, "settings.json");
      if (File.Exists(settingsPath)) {
        var settings = json.DeserializeObject(File.ReadAllText(settingsPath));
        if (Number(settings, "port") > 0) port = Number(settings, "port");
        expectedSteamid = Text(settings, "steamid");
      }
      main = Load("MainWindow.xaml");
      hud = Load("HudWindow.xaml");
      main.SourceInitialized += delegate {
        mainHandle = new WindowInteropHelper(main).Handle;
        hotkeySource = HwndSource.FromHwnd(mainHandle);
        hotkeySource.AddHook(Hotkey);
        hotkeyH = Native.RegisterHotKey(mainHandle, 1, 0x4003, 0x48);
        hotkeyL = Native.RegisterHotKey(mainHandle, 2, 0x4003, 0x4C);
      };
      hud.SourceInitialized += delegate { ApplyLock(); };
      Click(main, "ShowHudButton", delegate { ShowHud(); });
      Click(main, "MinimizeButton", delegate { main.WindowState = WindowState.Minimized; });
      Click(main, "CloseButton", delegate { Exit(); });
      Click(main, "FolderButton", delegate {
        var data = Path.Combine(root, "data"); Directory.CreateDirectory(data);
        Process.Start(new ProcessStartInfo("explorer.exe", "\"" + data + "\"") { UseShellExecute = true });
      });
      Click(hud, "HudExpandButton", delegate { ShowMain(); });
      Click(hud, "HudLockButton", delegate { ToggleLock(); });
      ((Grid)main.FindName("DragHeader")).MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
        if (e.OriginalSource is Button || IsButton(e.OriginalSource as DependencyObject)) return;
        if (e.LeftButton == MouseButtonState.Pressed) main.DragMove();
      };
      ((Grid)hud.FindName("HudDrag")).MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
        if (locked || IsButton(e.OriginalSource as DependencyObject)) return;
        if (e.LeftButton == MouseButtonState.Pressed) { hud.DragMove(); SavePosition(); }
      };
      main.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (!exiting) { e.Cancel = true; Exit(); } };
      RestorePosition();
      var languages = (ComboBox)main.FindName("LanguageSelector");
      languages.ItemsSource = translations.Languages;
      languages.SelectedItem = translations.Languages.First(pack => pack.code == translations.Code);
      ApplyLanguage();
      languages.SelectionChanged += delegate {
        var selected = languages.SelectedItem as LanguagePack;
        if (selected == null || selected.code == translations.Code) return;
        translations.Select(selected.code);
        ApplyLanguage();
        SavePosition();
      };
      timer.Interval = TimeSpan.FromSeconds(1);
      timer.Tick += async delegate { await Refresh(); };
    }

    void ApplyLanguage() {
      main.Language = System.Windows.Markup.XmlLanguage.GetLanguage(translations.Culture.IetfLanguageTag);
      hud.Language = main.Language;
      translations.Apply(main); translations.Apply(hud);
      main.Title = T("appTitle"); hud.Title = T("hudTitle");
      ApplyLock();
      if (tray != null) BuildTrayMenu();
      historyFingerprint = "";
      if (lastSummary != null) Update(lastSummary);
    }

    static bool IsButton(DependencyObject element) {
      while (element != null) {
        if (element is Button) return true;
        try { element = VisualTreeHelper.GetParent(element); } catch { return false; }
      }
      return false;
    }
    IntPtr Hotkey(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled) {
      if (message == 0x0312) {
        if (wParam.ToInt32() == 1) { if (hud.IsVisible) ShowMain(); else ShowHud(); handled = true; }
        if (wParam.ToInt32() == 2) { ToggleLock(); handled = true; }
      }
      return IntPtr.Zero;
    }
    void ApplyLock() {
      Set(hud, "HudLockState", locked ? T("locked") : T("movable"));
      var handle = new WindowInteropHelper(hud).Handle;
      if (handle == IntPtr.Zero) return;
      int style = Native.GetWindowLong(handle, -20);
      const int transparent = 0x20, noActivate = 0x08000000;
      Native.SetWindowLong(handle, -20, locked ? style | transparent | noActivate : style & ~transparent & ~noActivate);
      ((Button)hud.FindName("HudLockButton")).Opacity = locked ? 0.4 : 1;
    }
    void ToggleLock() { locked = !locked; ApplyLock(); SavePosition(); }
    void ShowHud() { main.Hide(); hud.Show(); ApplyLock(); SavePosition(); }
    void ShowMain() { hud.Hide(); main.Show(); main.WindowState = WindowState.Normal; main.Activate(); SavePosition(); }
    void RestorePosition() {
      hud.Left = SystemParameters.WorkArea.Right - hud.Width - 24;
      hud.Top = SystemParameters.WorkArea.Top + 110;
      string filename = Path.Combine(root, "data", "ui-settings.json");
      if (!File.Exists(filename)) return;
      try {
        var settings = json.DeserializeObject(File.ReadAllText(filename));
        translations.Select(Text(settings,"language","en"));
        startWithHud = Text(settings,"showHud").Equals("True",StringComparison.OrdinalIgnoreCase);
        double left = Convert.ToDouble(Value(settings, "left"), CultureInfo.InvariantCulture);
        double top = Convert.ToDouble(Value(settings, "top"), CultureInfo.InvariantCulture);
        if (left >= SystemParameters.VirtualScreenLeft && left + hud.Width <= SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth && top >= SystemParameters.VirtualScreenTop && top + hud.Height <= SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight) {
          hud.Left = left; hud.Top = top;
        }
        locked = Text(settings, "locked").Equals("True", StringComparison.OrdinalIgnoreCase);
      } catch { }
    }
    void SavePosition() {
      try {
        Directory.CreateDirectory(Path.Combine(root, "data"));
        File.WriteAllText(Path.Combine(root, "data", "ui-settings.json"), json.Serialize(new { left = hud.Left, top = hud.Top, locked = locked, language = translations.Code, showHud = hud.IsVisible }), new System.Text.UTF8Encoding(false));
      } catch { }
    }
    void CreateTray() {
      tray = new Forms.NotifyIcon();
      using (var bitmap = new System.Drawing.Bitmap(32, 32)) {
        using (var g = System.Drawing.Graphics.FromImage(bitmap)) {
          g.Clear(System.Drawing.Color.FromArgb(242, 152, 84));
          using (var pen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(20, 24, 30), 3)) {
            g.DrawLines(pen, new [] { new System.Drawing.Point(7,24), new System.Drawing.Point(14,7), new System.Drawing.Point(21,24) });
            g.DrawLine(pen, 10, 18, 18, 18); g.DrawLine(pen, 26, 7, 26, 24);
          }
        }
        var handle = bitmap.GetHicon();
        using (var original = System.Drawing.Icon.FromHandle(handle)) tray.Icon = (System.Drawing.Icon)original.Clone();
        Native.DestroyIcon(handle);
      }
      tray.Text = T("appTitle");
      main.Icon = Imaging.CreateBitmapSourceFromHIcon(tray.Icon.Handle, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
      BuildTrayMenu();
      tray.DoubleClick += delegate { ShowMain(); };
      tray.Visible = true;
    }
    void BuildTrayMenu() {
      var previous = tray.ContextMenuStrip;
      var menu = new Forms.ContextMenuStrip();
      menu.Items.Add(T("openWindow"), null, delegate { main.Dispatcher.Invoke(new Action(ShowMain)); });
      menu.Items.Add(T("showHud"), null, delegate { main.Dispatcher.Invoke(new Action(ShowHud)); });
      menu.Items.Add(T("lockHud"), null, delegate { main.Dispatcher.Invoke(new Action(ToggleLock)); });
      menu.Items.Add(new Forms.ToolStripSeparator());
      menu.Items.Add(T("exitDisplay"), null, delegate { main.Dispatcher.Invoke(new Action(Exit)); });
      tray.ContextMenuStrip = menu;
      if (previous != null) previous.Dispose();
    }
    async Task EnsureBackend() {
      if (backendStarting) return;
      backendStarting = true;
      try {
        var start = new ProcessStartInfo("powershell.exe", "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "Start.ps1") + "\"");
        start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
        using (var process = Process.Start(start)) await Task.Run(delegate { process.WaitForExit(15000); });
        var settings = json.DeserializeObject(File.ReadAllText(Path.Combine(root, "settings.json")));
        if (Number(settings, "port") > 0) port = Number(settings, "port");
        expectedSteamid = Text(settings, "steamid");
      } catch (Exception) { Set(main, "CurrentDetail", T("setupProblem")); }
      finally { backendStarting = false; }
    }

    public async Task Refresh() {
      if (busy) return;
      busy = true;
      try {
        Update(await LoadSummary());
      } catch (Exception error) {
        Set(main, "CurrentMap", T("receiverOffline")); Set(main, "CurrentDetail", T("startReceiver"));
        if (error is InvalidDataException) Set(main,"CurrentDetail",error.Message);
        Set(main, "StatusText", T("noLocalConnection"));
        ((System.Windows.Shapes.Ellipse)main.FindName("StatusDot")).Fill = Brush("#BE7665");
        Set(hud, "HudMap", T("receiverOffline")); Set(hud, "HudState", T("noConnection"));
      } finally { busy = false; }
    }

    async Task<object> LoadSummary() {
      try {
        var payload = await client.GetStringAsync("http://127.0.0.1:" + port + "/summary").ConfigureAwait(false);
        var summary = json.DeserializeObject(payload);
        CheckAccount(Value(summary,"status"));
        return summary;
      } catch (HttpRequestException) { }
      {
        // An existing pre-GUI receiver can remain running while upgrading.
        // Its live /status plus the same local result files provide the UI data.
        var statusPayload = await client.GetStringAsync("http://127.0.0.1:" + port + "/status").ConfigureAwait(false);
        var status = json.DeserializeObject(statusPayload);
        CheckAccount(status);
        var data = Path.Combine(root, "data");
        var stateFile = Path.Combine(data, "state.json");
        var state = File.Exists(stateFile) ? json.DeserializeObject(File.ReadAllText(stateFile)) : null;
        var wins = Value(state, "wins") as object[] ?? new object[0];
        var knownWins = new HashSet<string>(wins.Select(win => Text(win, "id")));
        var history = new List<Dictionary<string,object>>();
        if (Directory.Exists(data)) foreach (var file in Directory.GetFiles(data, "result-*.json")) {
          try {
            var result = json.DeserializeObject(File.ReadAllText(file));
            var payload = Value(result,"payload"); var player = Value(payload,"player");
            var id = Path.GetFileNameWithoutExtension(file).Substring(7);
            bool live = Convert.ToBoolean(Value(result,"observedLive") ?? false);
            bool candidate = Convert.ToBoolean(Value(result,"candidateWin") ?? false);
            string outcome = knownWins.Contains(id) ? "win" : Text(result,"excludedReason") == "local_practice" ? "practice" : candidate ? "unverified" : !live ? "partial" : "no_win";
            string timestamp = Text(result,"observedAt");
            var win = wins.FirstOrDefault(item => Text(item,"id") == id);
            if (win != null) timestamp = Text(win,"endedAt");
            history.Add(new Dictionary<string,object> {
              {"id",id}, {"map",Text(Value(payload,"map"),"name")}, {"endedAt",timestamp}, {"outcome",outcome},
              {"kills",Value(Value(player,"match_stats"),"kills")}, {"deaths",Value(Value(player,"match_stats"),"deaths")}
            });
          } catch { }
        }
        var ordered = history.OrderByDescending(item => Text(item,"endedAt")).Take(40).Cast<object>().ToArray();
        return new Dictionary<string,object> {
          {"status",status},
          {"stats",new Dictionary<string,object> { {"wins",Number(status,"winsSinceInstallation")}, {"completedMatches",history.Count}, {"practiceExcluded",history.Count(item => Text(item,"outcome") == "practice")} }},
          {"lastWin",wins.OrderByDescending(win => Text(win,"endedAt")).FirstOrDefault()},
          {"history",ordered}
        };
      }
    }
    void CheckAccount(object status) {
      if (!string.IsNullOrEmpty(expectedSteamid) && Text(status,"steamid") != expectedSteamid)
        throw new InvalidDataException(T("wrongAccount"));
    }
    void Update(object payload) {
      lastSummary = payload;
      var stats = Value(payload, "stats"); var status = Value(payload, "status"); var current = Value(status, "lastGameState");
      int wins = Number(stats, "wins");
      Set(main, "WinNumber", wins.ToString("00")); Set(hud, "HudWins", wins.ToString("00"));
      Set(main, "PracticeNumber", Number(stats, "practiceExcluded").ToString());
      var lastWin = Value(payload, "lastWin");
      Set(main, "LastWinMap", lastWin == null ? T("noWinYet") : MapName(Text(lastWin, "map")));
      Set(main, "LastWinTime", lastWin == null ? T("recordedAutomatically") : LocalTime(Text(lastWin, "endedAt"), "lastWinDateFormat"));
      DateTimeOffset received;
      bool fresh = DateTimeOffset.TryParse(Text(status, "lastReceived"), out received) && (DateTimeOffset.UtcNow - received).TotalSeconds <= 18;
      string map = Text(current, "map"); string connection = Text(Value(status, "connection"), "type");
      string stateText, detail, stateColor;
      if (!fresh) { stateText = T("waitingForCs2"); detail = T("receiverReady"); stateColor = "#8795A8"; }
      else if (string.IsNullOrEmpty(map)) { stateText = T("mainMenu"); detail = T("readyNextMatch"); stateColor = "#8795A8"; }
      else if (connection == "local_practice") { stateText = MapName(map); detail = T("practiceStatus"); stateColor = "#C3AB80"; }
      else if (connection == "online") { stateText = MapName(map); detail = Text(current, "phase") == "gameover" ? T("onlineEnded") : T("onlineActive"); stateColor = "#86B99F"; }
      else { stateText = MapName(map); detail = T("connectionUnverified"); stateColor = "#C3AB80"; }
      Set(main, "CurrentMap", stateText); Set(main, "CurrentDetail", detail);
      Set(hud, "HudMap", stateText); Set(hud, "HudState", fresh && !string.IsNullOrEmpty(map) ? detail : T("readyOnlineOnly"));
      Set(main, "StatusText", T("accountStatus", Text(status, "steamid")));
      ((System.Windows.Shapes.Ellipse)main.FindName("StatusDot")).Fill = Brush(stateColor);
      Label(hud, "HudState").Foreground = Brush(stateColor);
      int matches = Number(stats, "completedMatches");
      Set(main, "HistoryCount", T(matches == 1 ? "matchesOne" : "matchesOther", matches));
      var history = Value(payload, "history") as object[];
      if (history == null) history = new object[0];
      string fingerprint = json.Serialize(history);
      if (fingerprint != historyFingerprint) { DrawHistory(history); historyFingerprint = fingerprint; }
      if (tray != null) tray.Text = T(wins == 1 ? "trayWinsOne" : "trayWinsOther", wins);
    }
    void DrawHistory(object[] history) {
      var rows = (StackPanel)main.FindName("HistoryRows"); rows.Children.Clear();
      if (history.Length == 0) {
        rows.Children.Add(new TextBlock { Text = T("emptyHistory"), Margin = new Thickness(0,25,0,25), Foreground = Brush("#9BA7B6"), FontSize = 12 });
        return;
      }
      foreach (var match in history) {
        var row = new Grid { Height = 42, Margin = new Thickness(0,0,8,0) };
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(155) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(76) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(104) });
        var line = new Border { BorderBrush = Brush("#29323D"), BorderThickness = new Thickness(0,0,0,1) };
        Grid.SetColumnSpan(line, 4); row.Children.Add(line);
        AddCell(row, 0, MapName(Text(match, "map")), "#D9E0E9", 12);
        string outcome = Text(match, "outcome");
        string label = T(outcome == "win" ? "outcomeWin" : outcome == "practice" ? "outcomePractice" : outcome == "no_win" ? "outcomeNoWin" : outcome == "partial" ? "outcomePartial" : "outcomeUnverified");
        AddCell(row, 1, label, outcome == "win" ? "#F3A465" : outcome == "practice" ? "#A1ACBB" : "#9CA7B6", 11);
        AddCell(row, 2, Text(match,"kills","–") + " / " + Text(match,"deaths","–"), "#9CA7B6", 11);
        var time = AddCell(row, 3, LocalTime(Text(match,"endedAt"), "historyDateFormat"), "#8795A6", 10);
        time.HorizontalAlignment = HorizontalAlignment.Right;
        rows.Children.Add(row);
      }
    }
    static TextBlock AddCell(Grid row, int column, string text, string color, int size) {
      var label = new TextBlock { Text = text, Foreground = Brush(color), FontSize = size, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
      Grid.SetColumn(label, column); row.Children.Add(label); return label;
    }
    public void Show() {
      CreateTray(); if (startWithHud) ShowHud(); else main.Show(); timer.Start();
      main.Dispatcher.BeginInvoke(new Action(async delegate { await EnsureBackend(); await Refresh(); }));
    }
    public void Preview(string output) {
      Update(LoadSummary().GetAwaiter().GetResult());
      main.Measure(new Size(main.Width, main.Height)); main.Arrange(new Rect(0,0,main.Width,main.Height)); main.UpdateLayout();
      var bitmap = new RenderTargetBitmap((int)main.Width, (int)main.Height, 96,96, PixelFormats.Pbgra32); bitmap.Render(main);
      var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
      using (var stream = File.Create(output)) encoder.Save(stream);
    }
    void Exit() {
      if (exiting) return; exiting = true;
      timer.Stop(); SavePosition();
      if (mainHandle != IntPtr.Zero) { if (hotkeyH) Native.UnregisterHotKey(mainHandle,1); if (hotkeyL) Native.UnregisterHotKey(mainHandle,2); }
      if (hotkeySource != null) hotkeySource.RemoveHook(Hotkey);
      if (tray != null) { tray.Visible = false; tray.Dispose(); }
      client.Dispose(); hud.Close(); main.Close(); Application.Current.Shutdown();
    }
  }

  static class Program {
    [STAThread] static void Main(string[] arguments) {
      string root = AppDomain.CurrentDomain.BaseDirectory;
      bool created;
      string mutexName = "Local\\ArmsRaceTrackerGui_" + root.ToLowerInvariant().GetHashCode().ToString("X");
      using (var mutex = new Mutex(true, mutexName, out created)) {
        if (!created) return;
        try {
          var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
          var ui = new TrackerUi(root);
          if (arguments.Length == 2 && arguments[0] == "--preview") { ui.Preview(arguments[1]); return; }
          ui.Show(); application.Run();
        } catch (Exception error) {
          Directory.CreateDirectory(Path.Combine(root,"data"));
          File.WriteAllText(Path.Combine(root,"data","gui-error.log"), error.ToString());
          string message = "The display could not start. Details are in data/gui-error.log.", title = "Arms Race Tracker";
          try {
            var language = new Translations(root);
            string preferences = Path.Combine(root,"data","ui-settings.json");
            if (File.Exists(preferences)) {
              var settings = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(preferences));
              if (settings.ContainsKey("language")) language.Select(Convert.ToString(settings["language"]));
            }
            message = language.Get("startupError"); title = language.Get("appTitle");
          } catch { }
          MessageBox.Show(message, title, MessageBoxButton.OK, MessageBoxImage.Error);
        }
      }
    }
  }
}
