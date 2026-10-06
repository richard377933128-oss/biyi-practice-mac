import Foundation
import UIKit
import SwiftUI
import Capacitor
import Translation

/// iOS 本地翻译：经 SwiftUI `translationTask` 调用系统 Translation。
/// （`TranslationSession(installedSource:)` 仅在语言已安装时可用；未安装必须走 translationTask 才能弹下载。）
@objc(AppleTranslatePlugin)
public class AppleTranslatePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "AppleTranslatePlugin"
  public let jsName = "AppleTranslate"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
  ]

  @objc func isAvailable(_ call: CAPPluginCall) {
    if #available(iOS 18.0, *) {
      call.resolve(["ok": true, "engine": "apple-translation"])
    } else {
      call.resolve(["ok": false, "reason": "need-ios18"])
    }
  }

  @objc func prepare(_ call: CAPPluginCall) {
    Task { @MainActor in
      let srcId = call.getString("source") ?? "zh-Hans"
      let tgtId = call.getString("target") ?? "en"
      guard #available(iOS 18.0, *) else {
        call.reject("需要 iOS 18 及以上")
        return
      }
      do {
        try await runTranslationSession(sourceId: srcId, targetId: tgtId, texts: [], prepareOnly: true)
        call.resolve(["ok": true, "source": srcId, "target": tgtId])
      } catch {
        call.reject(Self.friendlyMessage(error))
      }
    }
  }

  @objc func translate(_ call: CAPPluginCall) {
    Task { @MainActor in
      let text = (call.getString("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else {
        call.resolve(["text": ""])
        return
      }
      let direction = call.getString("direction") ?? "zh-en"
      let srcId = direction == "en-zh" ? "en" : "zh-Hans"
      let tgtId = direction == "en-zh" ? "zh-Hans" : "en"
      guard #available(iOS 18.0, *) else {
        call.reject("需要 iOS 18 及以上")
        return
      }
      do {
        let outs = try await runTranslationSession(sourceId: srcId, targetId: tgtId, texts: [text], prepareOnly: false)
        call.resolve(["text": outs.first ?? "", "engine": "apple-translation"])
      } catch {
        call.reject(Self.friendlyMessage(error))
      }
    }
  }

  @available(iOS 18.0, *)
  @MainActor
  private func runTranslationSession(sourceId: String, targetId: String, texts: [String], prepareOnly: Bool) async throws -> [String] {
    let source = Locale.Language(identifier: sourceId)
    let target = Locale.Language(identifier: targetId)

    // 语言已安装时，优先无无 UI 会话（更快）
    if #available(iOS 26.0, *) {
      let availability = LanguageAvailability()
      let status = await availability.status(from: source, to: target)
      if status == .installed {
        do {
          let session = TranslationSession(installedSource: source, target: target)
          if prepareOnly {
            try await session.prepareTranslation()
            return []
          }
          var outs: [String] = []
          for t in texts {
            let r = try await session.translate(t)
            outs.append(r.targetText)
          }
          return outs
        } catch {
          // 回退到 translationTask（可弹下载/授权）
        }
      }
    }

    guard let host = bridge?.viewController else {
      throw NSError(domain: "AppleTranslate", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法打开翻译界面"])
    }

    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String], Error>) in
      var finished = false
      let finish: (Result<[String], Error>) -> Void = { result in
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async {
          host.dismiss(animated: true) {
            switch result {
            case .success(let v): cont.resume(returning: v)
            case .failure(let e): cont.resume(throwing: e)
            }
          }
        }
      }

      let root = TranslateBridgeView(
        source: source,
        target: target,
        texts: texts,
        prepareOnly: prepareOnly,
        onFinish: finish
      )
      let hc = UIHostingController(rootView: root)
      hc.view.backgroundColor = .clear
      hc.modalPresentationStyle = .overFullScreen
      hc.modalTransitionStyle = .crossDissolve
      host.present(hc, animated: false)
    }
  }

  private static func friendlyMessage(_ error: Error) -> String {
    let raw = (error as NSError).localizedDescription
    let lower = raw.lowercased()
    if raw.contains("无法翻译")
      || lower.contains("unable")
      || lower.contains("not installed")
      || lower.contains("download")
      || (error as NSError).domain.contains("Translation") {
      return "系统翻译失败：请先安装中/英翻译语言包（设置 → 通用 → 语言与地区 → 翻译语言），点「准备系统翻译」时若弹出下载请允许"
    }
    return raw.isEmpty ? "系统翻译失败" : raw
  }
}

@available(iOS 18.0, *)
private struct TranslateBridgeView: View {
  let source: Locale.Language
  let target: Locale.Language
  let texts: [String]
  let prepareOnly: Bool
  let onFinish: (Result<[String], Error>) -> Void

  @State private var configuration: TranslationSession.Configuration?
  @State private var started = false

  var body: some View {
    Color.black.opacity(0.001)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .translationTask(configuration) { session in
        do {
          if prepareOnly {
            try await session.prepareTranslation()
            onFinish(.success([]))
          } else {
            var outs: [String] = []
            outs.reserveCapacity(texts.count)
            for t in texts {
              let r = try await session.translate(t)
              outs.append(r.targetText)
            }
            onFinish(.success(outs))
          }
        } catch {
          onFinish(.failure(error))
        }
      }
      .onAppear {
        guard !started else { return }
        started = true
        // 赋值 configuration 才会触发 translationTask
        configuration = TranslationSession.Configuration(source: source, target: target)
      }
  }
}
