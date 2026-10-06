import UIKit
import WebKit
import AVFoundation
import Capacitor

/// 固定缩放（禁止捏合/双击放大），但允许上下滑动
class BridgeViewController: CAPBridgeViewController {
  private static let pageBackground = UIColor(red: 0.953, green: 0.937, blue: 0.894, alpha: 1)
  private var zoomLockObserver: NSObjectProtocol?
  private var audioInterruptObserver: NSObjectProtocol?

  override func capacitorDidLoad() {
    super.capacitorDidLoad()
    // 本地 Swift 插件不在 npm packageClassList 里，必须手动挂上
    bridge?.registerPluginInstance(ImeEnglishPlugin())
    bridge?.registerPluginInstance(SystemCameraPlugin())
    bridge?.registerPluginInstance(AppleTranslatePlugin())
    bridge?.registerPluginInstance(AppleSpeechPlugin())
    activatePlaybackSession()
    applyChrome()
    lockZoomAllowScroll()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    activatePlaybackSession()
    applyChrome()
    lockZoomAllowScroll()
  }

  deinit {
    if let zoomLockObserver {
      NotificationCenter.default.removeObserver(zoomLockObserver)
    }
    if let audioInterruptObserver {
      NotificationCenter.default.removeObserver(audioInterruptObserver)
    }
  }

  /// 静音键拨下时也要能听朗读（默认 ambient 会被静音）
  private func activatePlaybackSession() {
    PlaybackAudioSession.activate()
    if audioInterruptObserver == nil {
      audioInterruptObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [weak self] note in
        guard
          let info = note.userInfo,
          let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: typeVal),
          type == .ended
        else { return }
        self?.activatePlaybackSession()
      }
    }
  }

  private func applyChrome() {
    view.backgroundColor = Self.pageBackground
    guard let webView else { return }
    webView.backgroundColor = Self.pageBackground
    webView.isOpaque = false
    webView.scrollView.backgroundColor = Self.pageBackground
  }

  private func lockZoomAllowScroll() {
    guard let webView else { return }
    let scrollView = webView.scrollView

    // 强制允许原生上下滑动（不要抢 scrollView.delegate，否则会和 Keyboard 插件互抢）
    scrollView.isScrollEnabled = true
    scrollView.bounces = true
    scrollView.alwaysBounceVertical = true
    scrollView.showsVerticalScrollIndicator = true
    scrollView.keyboardDismissMode = .interactive
    scrollView.contentInsetAdjustmentBehavior = .never
    scrollView.contentInset = .zero
    scrollView.scrollIndicatorInsets = .zero

    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 1
    scrollView.zoomScale = 1
    scrollView.bouncesZoom = false
    scrollView.pinchGestureRecognizer?.isEnabled = false
    for gesture in scrollView.gestureRecognizers ?? [] {
      if let tap = gesture as? UITapGestureRecognizer, tap.numberOfTapsRequired == 2 {
        tap.isEnabled = false
      }
    }
    if #available(iOS 15.0, *) {
      webView.configuration.defaultWebpagePreferences.preferredContentMode = .mobile
    }

    // 键盘弹出后插件可能改 scrollEnabled，再强制开一次
    if zoomLockObserver == nil {
      zoomLockObserver = NotificationCenter.default.addObserver(
        forName: UIResponder.keyboardDidShowNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.lockZoomAllowScroll()
      }
    }
  }
}
