import Foundation
import UIKit
import Capacitor

/// iOS：笔译框聚焦时尽量切到英文/ASCII 键盘。
/// 系统不允许第三方 App 直接切换输入法，这里用 input traits + reloadInputViews 尽量逼近桌面行为。
@objc(ImeEnglishPlugin)
public class ImeEnglishPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "ImeEnglishPlugin"
  public let jsName = "ImeEnglish"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "selectEnglish", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
  ]

  @objc func selectEnglish(_ call: CAPPluginCall) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let webView = self.bridge?.webView else {
        call.resolve(["ok": false, "reason": "no-webview"])
        return
      }
      let js = """
      (function () {
        var el = document.getElementById('translation-input');
        if (!el) return false;
        el.setAttribute('lang', 'en');
        el.setAttribute('inputmode', 'latin');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('autocorrect', 'off');
        el.setAttribute('spellcheck', 'false');
        el.dataset.pteImeEnglish = '1';
        return true;
      })();
      """
      webView.evaluateJavaScript(js) { _, _ in
        Self.applyAsciiTraits(in: webView)
        webView.reloadInputViews()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
          Self.applyAsciiTraits(in: webView)
          webView.reloadInputViews()
        }
        call.resolve(["ok": true, "platform": "ios"])
      }
    }
  }

  @objc func restore(_ call: CAPPluginCall) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let webView = self.bridge?.webView else {
        call.resolve(["ok": true, "skipped": true])
        return
      }
      let js = """
      (function () {
        var el = document.getElementById('translation-input');
        if (!el) return;
        el.setAttribute('lang', 'en');
        el.setAttribute('inputmode', 'latin');
        el.dataset.pteImeEnglish = '0';
      })();
      """
      webView.evaluateJavaScript(js) { _, _ in
        call.resolve(["ok": true, "platform": "ios"])
      }
    }
  }

  private static func applyAsciiTraits(in root: UIView) {
    let ascii = UIKeyboardType.asciiCapable.rawValue
    var stack: [UIView] = [root]
    while let view = stack.popLast() {
      stack.append(contentsOf: view.subviews)
      let name = NSStringFromClass(type(of: view))
      guard name.contains("WKContent") || name.contains("UIWeb") || view is UITextField || view is UITextView else {
        continue
      }
      if view.responds(to: Selector(("setKeyboardType:"))) {
        view.setValue(ascii, forKey: "keyboardType")
      }
      if view.responds(to: Selector(("setAutocorrectionType:"))) {
        view.setValue(UITextAutocorrectionType.no.rawValue, forKey: "autocorrectionType")
      }
      if view.responds(to: Selector(("setSpellCheckingType:"))) {
        view.setValue(UITextSpellCheckingType.no.rawValue, forKey: "spellCheckingType")
      }
      if view.responds(to: Selector(("setAutocapitalizationType:"))) {
        view.setValue(UITextAutocapitalizationType.none.rawValue, forKey: "autocapitalizationType")
      }
      view.reloadInputViews()
    }
  }
}
