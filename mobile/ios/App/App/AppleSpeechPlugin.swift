import Foundation
import AVFoundation
import MediaPlayer
import UIKit
import Capacitor

/// 统一管理音频会话：
/// - 平时：纯播放（静音键拨下也能听朗读）
/// - 录音中（WebView 已把会话切到 playAndRecord）：不能再强行切回 .playback，
///   否则录音与朗读互相抢会话，出现电流声；这里保持 playAndRecord 并关掉语音通话处理（mode .default）。
enum PlaybackAudioSession {
  static func activate() {
    let session = AVAudioSession.sharedInstance()
    do {
      if session.category == .playAndRecord {
        try session.setCategory(
          .playAndRecord,
          mode: .default,
          options: [.defaultToSpeaker, .allowBluetoothA2DP, .duckOthers]
        )
      } else {
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      }
      try session.setActive(true, options: [])
    } catch {
      print("PlaybackAudioSession", error)
    }
  }
}

/// iOS 本机朗读。
///
/// 设计要点（围绕「读久了 / 停多了会假死，必须重启 App 才有声」这个顽疾）：
/// 1. AVSpeechSynthesizer 在反复 stop→speak、暂停/恢复、被系统打断之后可能静默卡死：
///    不报错、不回调、不出声，只有新建实例才能恢复。因此每次硬停后旧实例一律作废，
///    新任务在全新合成器上开口；并配看门狗兜底「开不了口 / 读到一半不动」的情况。
/// 2. 看门狗只依赖「该来的回调没来」，不猜内部状态；触发后自动重建合成器并从中断句
///    继续（队列模式）或重读一次（单句 / 点读），全程不需要用户退出 App。
/// 3. 音频会话在每次开口前、打断结束、耳机拔出时都会重新激活，避免会话被挂起后无声。
@objc(AppleSpeechPlugin)
public class AppleSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
  public let identifier = "AppleSpeechPlugin"
  public let jsName = "AppleSpeech"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "speakQueue", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "speakAside", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stopAside", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "currentVoice", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "listVoices", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "updateNowPlaying", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "setIdleTimer", returnType: CAPPluginReturnPromise),
  ]

  // MARK: 合成器（可重建）

  /// 主合成器：全文队列 / 单句。重建后旧实例的迟到回调按实例比对丢弃。
  private var synthesizer: AVSpeechSynthesizer?
  /// 点单词 / 点读用的旁路合成器，避免打断全文排队
  private var asideSynth: AVSpeechSynthesizer?
  /// 硬停之后旧实例不可信，下一次开口前必须换新实例
  private var mainStale = true
  private var asideStale = true

  private var asideCall: CAPPluginCall?
  private var asideUtterance: AVSpeechUtterance?
  private var pendingCall: CAPPluginCall?
  private var activeVoiceInfo: [String: Any] = [:]
  /// 当前这一轮要读的 utterance；代理回调只认这里面的，旧任务被取消的回调一律忽略
  private var currentUtterances: [AVSpeechUtterance] = []
  private var queueMode = false
  /// 队列里当前在读的下标（自愈续读用）
  private var queueIndex = 0
  /// 单篇循环：最后一句读完后在原生侧直接重排下一轮，不打断音频会话 / Now Playing 状态
  private var loopQueue = false
  private var queueLines: [String] = []
  private var queueVoiceIds: [String] = []
  private var queueFallbackVoiceId = ""
  private var queuePauseMs = 420
  private var queueRate: Float = 0.92
  private var queueRound = 0
  private var remoteBound = false
  private var nowPlayingTitle = "全文朗读"
  private var nowPlayingOffset = 0
  private var nowPlayingGrand = 0

  /// 用户（页面按钮 / 锁屏 / 耳机）主动暂停；系统自己造成的暂停不算
  private var userPaused = false

  // MARK: 看门狗

  private var watchdog: DispatchWorkItem?
  /// 单句重试次数（卡死重建后只自动重试一次，再不行把错误交回 JS 走回退）
  private var singleRetried = false
  /// 队列自愈次数上限，避免反复重建空转
  private var queueRecoveries = 0

  private func disarmWatchdog() {
    watchdog?.cancel()
    watchdog = nil
  }

  private func armWatchdog(_ delay: TimeInterval, _ action: @escaping () -> Void) {
    disarmWatchdog()
    let item = DispatchWorkItem(block: action)
    watchdog = item
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }

  /// 按文本长度估一个「读完该用了多久」的宽松上限（朗读下限约 5 字符/秒，再给足余量）
  private func finishDeadline(for text: String) -> TimeInterval {
    min(90, Double(max(text.count, 20)) / 5.0 + 8.0)
  }

  // MARK: 生命周期

  public override func load() {
    super.load()
    activateSession()
    observeLifecycle()
  }

  /// 锁屏 / 切后台 / 被打断时，如果不是用户自己暂停的，就自动接着读
  private func observeLifecycle() {
    let nc = NotificationCenter.default
    nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.resumeIfSystemPaused(after: 0.4)
      self?.resumeIfSystemPaused(after: 1.5)
    }
    nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 99
      NSLog("[Speech] interruption type=%d", Int(type))
      if type == AVAudioSession.InterruptionType.ended.rawValue {
        PlaybackAudioSession.activate()
        self?.resumeIfSystemPaused(after: 0.2)
        self?.resumeIfSystemPaused(after: 1.2)
      }
    }
    // 拔出耳机 / 切换输出设备：系统会把会话挂起，需要重新激活并确认还在发声
    nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
      let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
      if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
        PlaybackAudioSession.activate()
        self?.resumeIfSystemPaused(after: 0.3)
      }
    }
  }

  private func resumeIfSystemPaused(after delay: TimeInterval) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.queueMode, !self.userPaused else { return }
      guard let synth = self.synthesizer else { return }
      if synth.isPaused {
        NSLog("[Speech] system paused the queue, resuming")
        PlaybackAudioSession.activate()
        synth.continueSpeaking()
        self.setNowPlayingRate(1.0)
        // 2.5 秒后校验：continue 没生效（合成器假死）就走自愈
        self.armWatchdog(2.5) { [weak self] in self?.queueSilenceCheck("post-continue") }
      } else if !synth.isSpeaking, self.pendingCall != nil {
        // 既不播也不停 = 静默丢失，自愈
        self.queueSilenceCheck("resume-check")
      }
    }
  }

  private func activateSession() {
    PlaybackAudioSession.activate()
  }

  // MARK: 语音选择

  /// 每次现场问系统：当前英文默认语音是哪一个（设置 → 辅助功能 → 朗读内容 → 声音）。
  private func resolveSystemEnglishVoice() -> AVSpeechSynthesisVoice? {
    let codes = [
      "en-US", "en-GB", "en-AU", "en-IE", "en-ZA", "en-IN", "en",
    ]
    for code in codes {
      if let voice = AVSpeechSynthesisVoice(language: code) {
        return voice
      }
    }
    return AVSpeechSynthesisVoice.speechVoices()
      .first { $0.language.lowercased().hasPrefix("en") }
  }

  /// 用户指定了声音就用指定的（该声音已被卸载则回退系统默认）
  private func resolveVoice(_ identifier: String?) -> AVSpeechSynthesisVoice? {
    if let id = identifier, !id.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: id) {
      return chosen
    }
    return resolveSystemEnglishVoice()
  }

  private func qualityLabel(_ voice: AVSpeechSynthesisVoice) -> String {
    switch voice.quality {
    case .premium: return "premium"
    case .enhanced: return "enhanced"
    default: return "default"
    }
  }

  private func voiceInfo(_ voice: AVSpeechSynthesisVoice?) -> [String: Any] {
    guard let voice else {
      return [
        "voiceId": "",
        "voiceName": "",
        "lang": "",
        "quality": "",
        "source": "none",
      ]
    }
    return [
      "voiceId": voice.identifier,
      "voiceName": voice.name,
      "lang": voice.language,
      "quality": qualityLabel(voice),
      "source": "system-default",
    ]
  }

  @objc func currentVoice(_ call: CAPPluginCall) {
    let voice = resolveSystemEnglishVoice()
    var info = voiceInfo(voice)
    info["checkedAt"] = Int(Date().timeIntervalSince1970 * 1000)
    info["installedEnglishCount"] = AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.lowercased().hasPrefix("en") }
      .count
    call.resolve(info)
  }

  @objc func listVoices(_ call: CAPPluginCall) {
    let current = resolveSystemEnglishVoice()
    let currentId = current?.identifier
    let voices = AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.lowercased().hasPrefix("en") }
      .map { voice -> [String: Any] in
        [
          "id": voice.identifier,
          "name": voice.name,
          "lang": voice.language,
          "quality": qualityLabel(voice),
          "isSystemDefault": voice.identifier == currentId,
        ]
      }
      .sorted { lhs, rhs in
        let lDef = (lhs["isSystemDefault"] as? Bool) == true
        let rDef = (rhs["isSystemDefault"] as? Bool) == true
        if lDef != rDef { return lDef && !rDef }
        return String(describing: lhs["name"]) < String(describing: rhs["name"])
      }
    call.resolve([
      "voices": voices,
      "current": voiceInfo(current),
      "checkedAt": Int(Date().timeIntervalSince1970 * 1000),
    ])
  }

  // MARK: 合成器获取（必要时重建）

  @discardableResult
  private func freshMainSynth() -> AVSpeechSynthesizer {
    if synthesizer == nil || mainStale {
      let old = synthesizer
      synthesizer = nil
      old?.delegate = nil
      if old?.isSpeaking == true || old?.isPaused == true {
        old?.stopSpeaking(at: .immediate)
      }
      let next = AVSpeechSynthesizer()
      next.delegate = self
      synthesizer = next
      mainStale = false
      NSLog("[Speech] main synth rebuilt")
    }
    return synthesizer!
  }

  @discardableResult
  private func freshAsideSynth() -> AVSpeechSynthesizer {
    if asideSynth == nil || asideStale {
      let old = asideSynth
      asideSynth = nil
      old?.delegate = nil
      if old?.isSpeaking == true || old?.isPaused == true {
        old?.stopSpeaking(at: .immediate)
      }
      let next = AVSpeechSynthesizer()
      next.delegate = self
      asideSynth = next
      asideStale = false
    }
    return asideSynth!
  }

  // MARK: 点读（旁路）

  private func finishAside(cancelled: Bool = false) {
    disarmAsideWatchdogIfIdle()
    asideUtterance = nil
    guard let call = asideCall else { return }
    asideCall = nil
    call.keepAlive = false
    call.resolve(["ok": true, "cancelled": cancelled])
  }

  /// 旁路看门狗和主看门狗共用一只定时器会互相顶掉；旁路单独一只
  private var asideWatchdog: DispatchWorkItem?

  private func disarmAsideWatchdogIfIdle() {
    asideWatchdog?.cancel()
    asideWatchdog = nil
  }

  private func armAsideWatchdog(_ delay: TimeInterval, _ action: @escaping () -> Void) {
    disarmAsideWatchdogIfIdle()
    let item = DispatchWorkItem(block: action)
    asideWatchdog = item
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }

  private func stopAsideSynth() {
    disarmAsideWatchdogIfIdle()
    finishAside(cancelled: true)
    if asideSynth?.isSpeaking == true || asideSynth?.isPaused == true {
      asideSynth?.stopSpeaking(at: .immediate)
      asideStale = true
    }
  }

  private func cancelAll() {
    disarmWatchdog()
    stopAsideSynth()
    loopQueue = false
    currentUtterances = []
    finishPending(ok: true, cancelled: true)
    endQueue()
    if synthesizer?.isSpeaking == true || synthesizer?.isPaused == true {
      synthesizer?.stopSpeaking(at: .immediate)
      mainStale = true
    }
  }

  @objc func speakAside(_ call: CAPPluginCall) {
    let text = (call.getString("text") ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      call.resolve(["ok": true, "empty": true])
      return
    }
    stopAsideSynth()
    activateSession()
    let voice = resolveVoice(call.getString("voiceId"))
    let utterance = makeUtterance(text, rate: call.getFloat("rate") ?? 0.92, voice: voice, postDelay: 0.02)
    asideUtterance = utterance
    call.keepAlive = true
    asideCall = call
    let synth = freshAsideSynth()
    synth.speak(utterance)
    // 点读开不了口：自愈一次，再不行把 promise 解了让 JS 不空等
    armAsideWatchdog(3.0) { [weak self] in
      guard let self, self.asideUtterance === utterance, self.asideCall != nil else { return }
      NSLog("[Speech] aside watchdog: no start, rebuilding")
      self.asideStale = true
      let retry = self.freshAsideSynth()
      PlaybackAudioSession.activate()
      retry.speak(utterance)
      self.armAsideWatchdog(self.finishDeadline(for: text)) { [weak self] in
        guard let self, self.asideUtterance === utterance, self.asideCall != nil else { return }
        NSLog("[Speech] aside watchdog: still silent, giving up")
        self.asideStale = true
        self.stopAsideSynth()
      }
    }
  }

  @objc func stopAside(_ call: CAPPluginCall) {
    stopAsideSynth()
    call.resolve(["ok": true])
  }

  @objc func stop(_ call: CAPPluginCall) {
    cancelAll()
    call.resolve(["ok": true])
  }

  // MARK: 暂停 / 继续

  /// 暂停 / 继续当前朗读（全文朗读里「点一下暂停、再点继续」）
  @objc func pause(_ call: CAPPluginCall) {
    if synthesizer?.isSpeaking == true && synthesizer?.isPaused == false {
      synthesizer?.pauseSpeaking(at: .immediate)
    }
    if queueMode { userPaused = true; setNowPlayingRate(0.0) }
    call.resolve(["ok": true])
  }

  @objc func resume(_ call: CAPPluginCall) {
    if synthesizer?.isPaused == true {
      synthesizer?.continueSpeaking()
      if queueMode {
        // 校验继续真的生效
        armWatchdog(2.5) { [weak self] in self?.queueSilenceCheck("post-js-resume") }
      }
    }
    userPaused = false
    if queueMode { setNowPlayingRate(1.0) }
    call.resolve(["ok": true])
  }

  // MARK: 构造 utterance

  private func makeUtterance(_ text: String, rate webRate: Float, voice: AVSpeechSynthesisVoice?, postDelay: TimeInterval) -> AVSpeechUtterance {
    let utterance = AVSpeechUtterance(string: text)
    let mapped = AVSpeechUtteranceDefaultSpeechRate * Float(max(0.75, min(1.15, webRate)))
    utterance.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, mapped))
    utterance.pitchMultiplier = 1.0
    utterance.preUtteranceDelay = 0.02
    utterance.postUtteranceDelay = postDelay
    utterance.volume = 1.0
    utterance.voice = voice
    return utterance
  }

  // MARK: 全文队列

  /// 整段全文一次性排队给系统朗读：锁屏/切后台后不依赖网页脚本，也能一句接一句读完。
  @objc func speakQueue(_ call: CAPPluginCall) {
    let rawLines = (call.getArray("lines", String.self) ?? [])
    var lines: [String] = []
    for l in rawLines {
      let t = l.trimmingCharacters(in: .whitespacesAndNewlines)
      if t.isEmpty { continue }
      lines.append(t)
    }
    guard !lines.isEmpty else {
      call.resolve(["ok": true, "empty": true])
      return
    }
    let pauseMs = max(0, min(3000, call.getInt("pauseMs") ?? 420))
    let webRate = call.getFloat("rate") ?? 0.92
    let title = call.getString("title") ?? "全文朗读"
    nowPlayingOffset = max(0, call.getInt("offset") ?? 0)
    nowPlayingGrand = call.getInt("grandTotal") ?? (lines.count + nowPlayingOffset)

    cancelAll()
    userPaused = false
    queueRecoveries = 0
    activateSession()

    queueLines = lines
    queueVoiceIds = call.getArray("voiceIds", String.self) ?? []
    queueFallbackVoiceId = call.getString("voiceId") ?? ""
    queuePauseMs = pauseMs
    queueRate = webRate
    loopQueue = call.getBool("loop") ?? false
    queueRound = 1
    queueIndex = 0

    let fallbackVoice = resolveVoice(queueFallbackVoiceId.isEmpty ? nil : queueFallbackVoiceId)
    activeVoiceInfo = voiceInfo(fallbackVoice)
    activeVoiceInfo["checkedAt"] = Int(Date().timeIntervalSince1970 * 1000)
    NSLog("[Speech] speakQueue lines=%d voices=%d loop=%d", lines.count, queueVoiceIds.count, loopQueue ? 1 : 0)

    let utterances = makeQueueUtterances()
    currentUtterances = utterances
    queueMode = true
    setIdleTimerDisabled(true)
    beginNowPlaying(title: title)

    call.keepAlive = true
    pendingCall = call
    let synth = freshMainSynth()
    // 只排队第一句开口，确保首句不被 AVSpeechSynthesizer 的调度 bug 跳过；
    // 剩余句在 didStart 第一句后逐个补上。
    if let first = utterances.first { synth.speak(first) }
    NSLog("[Speech] speakQueue: first queued, total=%d, loop=%d", utterances.count, loopQueue ? 1 : 0)
    // 队列开不了口：自愈（重建 + 重排）
    armWatchdog(4.0) { [weak self] in
      guard let self, self.queueMode, self.pendingCall != nil else { return }
      self.recoverQueue(reason: "queue-no-start")
    }
  }

  /// 按保存的配置构建一轮 utterance；循环模式下最后一句也带停顿，衔接到下一轮第一句
  private func makeQueueUtterances() -> [AVSpeechUtterance] {
    let fallbackVoice = resolveVoice(queueFallbackVoiceId.isEmpty ? nil : queueFallbackVoiceId)
    var utterances: [AVSpeechUtterance] = []
    for (i, line) in queueLines.enumerated() {
      let isLast = i == queueLines.count - 1
      let post: TimeInterval = (!isLast || loopQueue) ? Double(queuePauseMs) / 1000.0 : 0.04
      let lineVoice = i < queueVoiceIds.count ? resolveVoice(queueVoiceIds[i]) : fallbackVoice
      utterances.append(makeUtterance(line, rate: queueRate, voice: lineVoice, postDelay: post))
    }
    return utterances
  }

  /// 队列读到一半不动了（合成器假死 / 会话被挂）：重建合成器，从当前句继续读
  /// confirmIndex：上次检查时正在读的句子下标；若这次还在读同一句，说明真卡住了
  private func queueSilenceCheck(_ reason: String, confirmIndex: Int = -1) {
    guard queueMode, pendingCall != nil, !userPaused else { return }
    guard let synth = synthesizer else {
      recoverQueue(reason: reason)
      return
    }
    if synth.isPaused {
      PlaybackAudioSession.activate()
      synth.continueSpeaking()
      armWatchdog(2.5) { [weak self] in self?.queueSilenceCheck("silence-recheck") }
      return
    }
    if !synth.isSpeaking {
      recoverQueue(reason: reason)
      return
    }
    // 自称在读：可能是长句还没读完（句长只是估算），给一次确认机会；
    // 4 秒后仍停留在同一句才认定假死，重建续读
    if confirmIndex < 0 {
      let stuck = queueIndex
      armWatchdog(4.0) { [weak self] in self?.queueSilenceCheck(reason, confirmIndex: stuck) }
    } else if confirmIndex == queueIndex {
      recoverQueue(reason: reason + "-speaking-stuck")
    }
  }

  private func recoverQueue(reason: String) {
    guard queueMode, pendingCall != nil else { return }
    guard queueRecoveries < 3 else {
      NSLog("[Speech] recoverQueue giving up after %d tries (%@)", queueRecoveries, reason)
      disarmWatchdog()
      endQueue()
      finishPending(ok: false, reason: "speak-queue-stalled")
      return
    }
    queueRecoveries += 1
    NSLog("[Speech] recoverQueue (%@) from line %d, try %d", reason, queueIndex + 1, queueRecoveries)
    mainStale = true
    let synth = freshMainSynth()
    PlaybackAudioSession.activate()
    let all = makeQueueUtterances()
    guard !all.isEmpty else {
      endQueue()
      finishPending(ok: false, reason: "speak-queue-stalled")
      return
    }
    currentUtterances = all
    let start = min(queueIndex, all.count - 1)
    // 从断点处只 speak 第一句，剩余等 didStart 后补上
    if start < all.count { synth.speak(all[start]) }
    armWatchdog(4.0) { [weak self] in
      guard let self, self.queueMode, self.pendingCall != nil else { return }
      self.queueSilenceCheck("post-recover")
    }
  }

  @objc func setIdleTimer(_ call: CAPPluginCall) {
    setIdleTimerDisabled(call.getBool("disabled") ?? false)
    call.resolve(["ok": true])
  }

  private func setIdleTimerDisabled(_ disabled: Bool) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = disabled
    }
  }

  // MARK: 锁屏播放控制（保持音频会话、锁屏界面可暂停/停止）

  private func beginNowPlaying(title: String) {
    nowPlayingTitle = title
    DispatchQueue.main.async {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = [
        MPMediaItemPropertyTitle: title,
        MPMediaItemPropertyArtist: "笔译训练",
        MPNowPlayingInfoPropertyPlaybackRate: 1.0,
      ]
      MPNowPlayingInfoCenter.default().playbackState = .playing
      self.bindRemoteCommands()
    }
  }

  /// 锁屏卡片的标题 / 副标题都只有一行：把整句按单词拆到两行
  private func splitForLock(_ text: String) -> (String, String) {
    let titleMax = 28
    let artistMax = 34
    let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    var title = ""
    var i = 0
    while i < words.count {
      let next = title.isEmpty ? words[i] : title + " " + words[i]
      if !title.isEmpty && next.count > titleMax { break }
      title = next
      i += 1
    }
    var artist = words[i...].joined(separator: " ")
    if artist.count > artistMax {
      var cut = String(artist.prefix(artistMax - 1))
      if let sp = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: sp) > 8 {
        cut = String(cut[..<sp])
      }
      artist = cut.trimmingCharacters(in: .whitespaces) + "…"
    }
    return (title, artist)
  }

  /// 网页把已画好的封面交给原生：先解码成 UIImage，再原地改 nowPlayingInfo。
  @objc func updateNowPlaying(_ call: CAPPluginCall) {
    let title = call.getString("title") ?? ""
    let artist = call.getString("artist") ?? ""
    let album = call.getString("album") ?? ""
    let artwork = call.getString("artwork") ?? ""
    let image = Self.imageFromDataUrl(artwork)
    DispatchQueue.main.async {
      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
      if !title.isEmpty { info[MPMediaItemPropertyTitle] = title }
      if !artist.isEmpty { info[MPMediaItemPropertyArtist] = artist }
      if !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }
      if let image {
        let size = image.size
        info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: size) { _ in image }
      }
      if info[MPNowPlayingInfoPropertyPlaybackRate] == nil {
        info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
      }
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      MPNowPlayingInfoCenter.default().playbackState = .playing
    }
    call.resolve(["ok": true])
  }

  private static func imageFromDataUrl(_ url: String) -> UIImage? {
    guard let range = url.range(of: "base64,") else { return nil }
    let b64 = String(url[range.upperBound...])
    guard let data = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]) else { return nil }
    return UIImage(data: data)
  }

  /// 锁屏界面同步显示正在读的这一句英文
  private func showNowPlayingLine(_ text: String, index: Int, total: Int) {
    let label = "\(nowPlayingTitle) · \(index + nowPlayingOffset)/\(max(nowPlayingGrand, total))"
    let (title, artist) = splitForLock(text)
    DispatchQueue.main.async {
      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
      info[MPMediaItemPropertyTitle] = title.isEmpty ? text : title
      info[MPMediaItemPropertyArtist] = artist.isEmpty ? label : artist
      info[MPMediaItemPropertyAlbumTitle] = label
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
  }

  private func setNowPlayingRate(_ rate: Double) {
    DispatchQueue.main.async {
      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
      info[MPNowPlayingInfoPropertyPlaybackRate] = rate
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      MPNowPlayingInfoCenter.default().playbackState = rate > 0 ? .playing : .paused
    }
  }

  private func endQueue() {
    guard queueMode else { return }
    queueMode = false
    disarmWatchdog()
    setIdleTimerDisabled(false)
    DispatchQueue.main.async {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      MPNowPlayingInfoCenter.default().playbackState = .stopped
    }
  }

  private func bindRemoteCommands() {
    guard !remoteBound else { return }
    remoteBound = true
    let center = MPRemoteCommandCenter.shared()
    center.playCommand.isEnabled = true
    center.pauseCommand.isEnabled = true
    center.stopCommand.isEnabled = true
    center.togglePlayPauseCommand.isEnabled = true
    center.playCommand.addTarget { [weak self] _ in
      guard let self, self.queueMode else { return .noActionableNowPlayingItem }
      self.userPaused = false
      self.synthesizer?.continueSpeaking()
      self.setNowPlayingRate(1.0)
      self.armWatchdog(2.5) { [weak self] in self?.queueSilenceCheck("post-remote-play") }
      return .success
    }
    center.pauseCommand.addTarget { [weak self] _ in
      guard let self, self.queueMode else { return .noActionableNowPlayingItem }
      self.userPaused = true
      self.disarmWatchdog()
      self.synthesizer?.pauseSpeaking(at: .word)
      self.setNowPlayingRate(0.0)
      return .success
    }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self, self.queueMode else { return .noActionableNowPlayingItem }
      if self.synthesizer?.isPaused == true {
        self.userPaused = false
        self.synthesizer?.continueSpeaking()
        self.setNowPlayingRate(1.0)
        self.armWatchdog(2.5) { [weak self] in self?.queueSilenceCheck("post-remote-toggle") }
      } else {
        self.userPaused = true
        self.disarmWatchdog()
        self.synthesizer?.pauseSpeaking(at: .word)
        self.setNowPlayingRate(0.0)
      }
      return .success
    }
    center.stopCommand.addTarget { [weak self] _ in
      guard let self, self.queueMode else { return .noActionableNowPlayingItem }
      self.cancelAll()
      self.notifyListeners("queueStopped", data: [:])
      return .success
    }
  }

  // MARK: 单句朗读（意群 / 点读长句）

  @objc func speak(_ call: CAPPluginCall) {
    let text = (call.getString("text") ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      call.resolve(["ok": true, "empty": true])
      return
    }

    cancelAll()
    activateSession()

    let voice = resolveVoice(call.getString("voiceId"))
    activeVoiceInfo = voiceInfo(voice)
    activeVoiceInfo["checkedAt"] = Int(Date().timeIntervalSince1970 * 1000)

    let webRate = call.getFloat("rate") ?? 0.92
    let utterance = makeUtterance(text, rate: webRate, voice: voice, postDelay: 0.04)
    currentUtterances = [utterance]

    call.keepAlive = true
    pendingCall = call
    singleRetried = false
    startSingle(utterance, text: text)
  }

  private func startSingle(_ utterance: AVSpeechUtterance, text: String) {
    let synth = freshMainSynth()
    synth.speak(utterance)
    // 4 秒内开不了口：重建合成器重试一次；再不行把错误交回 JS（那边有 web 回退）
    armWatchdog(4.0) { [weak self] in
      guard let self, self.pendingCall != nil, !self.queueMode else { return }
      guard self.currentUtterances.first === utterance else { return }
      if !self.singleRetried {
        self.singleRetried = true
        NSLog("[Speech] speak watchdog: no start, retry on fresh synth")
        self.mainStale = true
        PlaybackAudioSession.activate()
        self.startSingle(utterance, text: text)
      } else {
        NSLog("[Speech] speak watchdog: still silent, reject to JS")
        self.mainStale = true
        self.finishPending(ok: false, reason: "speak-timeout")
      }
    }
  }

  private func finishPending(ok: Bool, cancelled: Bool = false, reason: String? = nil) {
    guard let call = pendingCall else { return }
    pendingCall = nil
    call.keepAlive = false
    if ok {
      var payload: [String: Any] = [
        "ok": true,
        "cancelled": cancelled,
      ]
      for (k, v) in activeVoiceInfo {
        payload[k] = v
      }
      call.resolve(payload)
    } else {
      call.reject(reason ?? "speak-failed")
    }
  }

  // MARK: AVSpeechSynthesizerDelegate

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth {
      // 旁路开读了：把「开口看门狗」换成「读完看门狗」
      if asideUtterance === utterance {
        armAsideWatchdog(finishDeadline(for: utterance.speechString)) { [weak self] in
          guard let self, self.asideUtterance === utterance, self.asideCall != nil else { return }
          NSLog("[Speech] aside watchdog: never finished, resetting")
          self.asideStale = true
          self.stopAsideSynth()
        }
      }
      return
    }
    guard synthesizer === self.synthesizer else { return }
    guard queueMode, let idx = currentUtterances.firstIndex(where: { $0 === utterance }) else {
      // 单句：开读了，换成「读完看门狗」
      if !queueMode, currentUtterances.first === utterance {
        armWatchdog(finishDeadline(for: utterance.speechString)) { [weak self] in
          guard let self, self.pendingCall != nil, !self.queueMode else { return }
          NSLog("[Speech] speak watchdog: never finished, reject to JS")
          self.mainStale = true
          self.finishPending(ok: false, reason: "speak-timeout")
        }
      }
      return
    }
    queueIndex = idx
    queueRecoveries = 0 // 有进展就清零自愈计数，允许长跑中多次自愈
    NSLog("[Speech] didStart %d/%d", idx + 1, currentUtterances.count)
    // speakQueue/loop/recover 都只 speak 了当前这一句；didStart 后立刻 speak 剩余的
    if currentUtterances.count > idx + 1 {
      let remaining = currentUtterances.dropFirst(idx + 1)
      NSLog("[Speech] queue remaining %d utterances", remaining.count)
      for u in remaining { synthesizer.speak(u) }
    }
    showNowPlayingLine(utterance.speechString, index: idx + 1, total: currentUtterances.count)
    notifyListeners("queueProgress", data: ["index": idx + 1, "total": currentUtterances.count])
    // 这句读完该来 didFinish；按句长给上限
    armWatchdog(finishDeadline(for: utterance.speechString)) { [weak self] in
      guard let self, self.queueMode, self.pendingCall != nil, !self.userPaused else { return }
      self.queueSilenceCheck("line-timeout")
    }
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth {
      if asideUtterance === utterance { finishAside() }
      return
    }
    guard synthesizer === self.synthesizer else { return }
    guard let idx = currentUtterances.firstIndex(where: { $0 === utterance }) else { return }
    if queueMode {
      // 队列：只有最后一句读完才算整段结束
      guard idx == currentUtterances.count - 1 else {
        // 下一句应该在「句间停顿 + 余量」内开读
        armWatchdog(Double(queuePauseMs) / 1000.0 + 5.0) { [weak self] in
          guard let self, self.queueMode, self.pendingCall != nil, !self.userPaused else { return }
          self.queueSilenceCheck("next-line-missing")
        }
        return
      }
      if loopQueue {
        // 单篇循环：原生侧直接重排下一轮。不打断音频会话、不动 Now Playing 状态、
        // 不解 pendingCall，JS 的 speakQueue 仍在等待，界面进度靠 queueProgress/queueLooped 刷新
        queueRound += 1
        NSLog("[Speech] loop round %d", queueRound)
        let utterances = makeQueueUtterances()
        currentUtterances = utterances
        // 和 speakQueue 一样：只 speak 第一句，剩余在 didStart 第一句后补上
        if let first = utterances.first { synthesizer.speak(first) }
        notifyListeners("queueLooped", data: ["round": queueRound])
        armWatchdog(4.0) { [weak self] in
          guard let self, self.queueMode, self.pendingCall != nil else { return }
          self.queueSilenceCheck("loop-restart")
        }
        return
      }
      disarmWatchdog()
      endQueue()
    } else {
      disarmWatchdog()
    }
    finishPending(ok: true)
  }

  // 暂停 / 继续（含锁屏界面、耳机触发的），通知网页同步按钮状态
  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth { return }
    guard synthesizer === self.synthesizer else { return }
    guard queueMode, currentUtterances.contains(where: { $0 === utterance }) else { return }
    // 用户暂停期间看门狗歇着；系统造成的暂停由 resumeIfSystemPaused 负责拉起
    if userPaused { disarmWatchdog() }
    notifyListeners("queueState", data: ["paused": true])
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth { return }
    guard synthesizer === self.synthesizer else { return }
    guard queueMode, currentUtterances.contains(where: { $0 === utterance }) else { return }
    notifyListeners("queueState", data: ["paused": false])
    armWatchdog(finishDeadline(for: utterance.speechString)) { [weak self] in
      guard let self, self.queueMode, self.pendingCall != nil, !self.userPaused else { return }
      self.queueSilenceCheck("post-continue-timeout")
    }
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth {
      if asideUtterance === utterance { finishAside(cancelled: true) }
      return
    }
    guard synthesizer === self.synthesizer else { return }
    // 被新任务/停止取消的旧 utterance 已不在 currentUtterances 里，直接忽略
    guard currentUtterances.contains(where: { $0 === utterance }) else { return }
    NSLog("[Speech] didCancel (queue ended)")
    disarmWatchdog()
    endQueue()
    finishPending(ok: true, cancelled: true)
  }
}
