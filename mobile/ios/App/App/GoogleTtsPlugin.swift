import Foundation
import Capacitor

/// 原生 Google TTS：用 URLSession 请求 translate.google.com，绕开 WKWebView 的 CORS 限制，走系统 VPN。
@objc(GoogleTtsPlugin)
public class GoogleTtsPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "GoogleTtsPlugin"
  public let jsName = "GoogleTts"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "synthesize", returnType: CAPPluginReturnPromise),
  ]

  @objc func synthesize(_ call: CAPPluginCall) {
    let text = (call.getString("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let voice = call.getString("voice") ?? "en-US-EmmaMultilingualNeural"
    guard !text.isEmpty else {
      call.reject("empty text")
      return
    }

    let tl: String
    if voice.lowercased().hasPrefix("zh") {
      tl = "zh-CN"
    } else if voice.lowercased().hasPrefix("en") {
      tl = "en"
    } else {
      tl = voice.split(separator: "-").first.map(String.init) ?? "en"
    }

    // 尝试多种参数组合
    let attempts: [[URLQueryItem]] = [
      // 组合1：tw-ob + total + idx
      [
        URLQueryItem(name: "ie", value: "UTF-8"),
        URLQueryItem(name: "client", value: "tw-ob"),
        URLQueryItem(name: "q", value: text),
        URLQueryItem(name: "tl", value: tl),
        URLQueryItem(name: "ttsspeed", value: "1"),
        URLQueryItem(name: "total", value: "1"),
        URLQueryItem(name: "idx", value: "0"),
      ],
      // 组合2：不加 client
      [
        URLQueryItem(name: "ie", value: "UTF-8"),
        URLQueryItem(name: "q", value: text),
        URLQueryItem(name: "tl", value: tl),
      ],
      // 组合3：client=gtx
      [
        URLQueryItem(name: "ie", value: "UTF-8"),
        URLQueryItem(name: "client", value: "gtx"),
        URLQueryItem(name: "q", value: text),
        URLQueryItem(name: "tl", value: tl),
      ],
    ]

    tryAttempt(call: call, attempts: attempts, index: 0)
  }

  private func tryAttempt(call: CAPPluginCall, attempts: [[URLQueryItem]], index: Int) {
    guard index < attempts.count else {
      call.reject("all attempts failed")
      return
    }

    var comps = URLComponents(string: "https://translate.google.com/translate_tts")!
    comps.queryItems = attempts[index]
    guard let url = comps.url else {
      tryAttempt(call: call, attempts: attempts, index: index + 1)
      return
    }

    var req = URLRequest(url: url)
    req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
    req.setValue("https://translate.google.com/", forHTTPHeaderField: "Referer")
    req.setValue("zh-CN,zh;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
    req.setValue("*/*", forHTTPHeaderField: "Accept")

    let task = URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
      if let error = error {
        self?.tryAttempt(call: call, attempts: attempts, index: index + 1)
        return
      }
      guard let http = response as? HTTPURLResponse else {
        self?.tryAttempt(call: call, attempts: attempts, index: index + 1)
        return
      }
      if http.statusCode != 200 {
        // 返回详细错误信息用于调试
        let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
        if index == attempts.count - 1 {
          // 最后一次尝试，返回详细错误
          call.reject("http \(http.statusCode): \(body.prefix(200))")
        } else {
          self?.tryAttempt(call: call, attempts: attempts, index: index + 1)
        }
        return
      }
      guard let data = data, !data.isEmpty else {
        call.reject("empty audio")
        return
      }
      let b64 = data.base64EncodedString()
      call.resolve(["data": b64, "mime": "audio/mpeg", "size": data.count])
    }
    task.resume()
  }
}
