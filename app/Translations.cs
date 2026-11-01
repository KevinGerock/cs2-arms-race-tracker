using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace ArmsRaceTracker {
  sealed class LanguagePack {
    public string code { get; set; }
    public string nativeName { get; set; }
    public string culture { get; set; }
    public Dictionary<string,string> strings { get; set; }
    public override string ToString() { return nativeName; }
  }

  sealed class Translations {
    readonly Dictionary<string,LanguagePack> packs = new Dictionary<string,LanguagePack>(StringComparer.OrdinalIgnoreCase);
    public string Code { get; private set; }
    public CultureInfo Culture { get { return CultureInfo.GetCultureInfo(packs[Code].culture); } }
    public IEnumerable<LanguagePack> Languages { get { return packs.Values.OrderBy(p => p.code == "en" ? "" : p.nativeName); } }
    public Translations(string root) {
      var json = new JavaScriptSerializer();
      foreach (string file in Directory.GetFiles(Path.Combine(root,"app","languages"),"*.json")) {
        var pack = json.Deserialize<LanguagePack>(File.ReadAllText(file,new UTF8Encoding(false,true)));
        if (pack == null || string.IsNullOrWhiteSpace(pack.code) || string.IsNullOrWhiteSpace(pack.nativeName) || pack.strings == null)
          throw new InvalidDataException("Invalid language pack: " + Path.GetFileName(file));
        CultureInfo.GetCultureInfo(pack.culture);
        packs.Add(pack.code,pack);
      }
      if (!packs.ContainsKey("en")) throw new InvalidDataException("English language pack is missing.");
      Select("en");
    }
    public void Select(string code) { Code = code != null && packs.ContainsKey(code) ? packs[code].code : "en"; }
    public string Get(string key, params object[] arguments) {
      string value;
      if (!packs[Code].strings.TryGetValue(key,out value) && !packs["en"].strings.TryGetValue(key,out value))
        throw new InvalidDataException("Missing translation: " + key);
      return arguments.Length == 0 ? value : string.Format(Culture,value,arguments);
    }
    public void Apply(DependencyObject node) {
      var element = node as FrameworkElement;
      var tags = element == null ? null : element.Tag as string;
      if (tags != null) foreach (string part in tags.Split(';')) {
        int split = part.IndexOf(':');
        if (split < 1) continue;
        string kind = part.Substring(0,split), value = Get(part.Substring(split+1));
        if (kind == "text") ((TextBlock)element).Text = value;
        else if (kind == "content") ((ContentControl)element).Content = value;
        else if (kind == "tooltip") element.ToolTip = value;
        else if (kind == "automation") AutomationProperties.SetName(element,value);
      }
      foreach (object child in LogicalTreeHelper.GetChildren(node)) {
        var dependency = child as DependencyObject;
        if (dependency != null) Apply(dependency);
      }
    }
  }
}
