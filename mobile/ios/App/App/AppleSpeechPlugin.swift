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

/// iOS 本机朗读：每次说话都实时读取系统「朗读内容」当前英文语音（不缓存、不强行换我们自己的排序）。
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

  private let synthesizer = AVSpeechSynthesizer()
  /// 点单词时用另一路合成器，避免打断全文排队
  private let asideSynth = AVSpeechSynthesizer()
  private var asideCall: CAPPluginCall?
  private var asideUtterance: AVSpeechUtterance?
  private var pendingCall: CAPPluginCall?
  private var activeVoiceInfo: [String: Any] = [:]
  /// 当前这一轮要读的 utterance；代理回调只认这里面的，旧任务被取消的回调一律忽略
  private var currentUtterances: [AVSpeechUtterance] = []
  private var queueMode = false
  private var remoteBound = false
  private var nowPlayingTitle = "全文朗读"
  private var nowPlayingOffset = 0
  private var nowPlayingGrand = 0

  /// 用户（页面按钮 / 锁屏 / 耳机）主动暂停；系统自己造成的暂停不算
  private var userPaused = false

  public override func load() {
    super.load()
    synthesizer.delegate = self
    asideSynth.delegate = self
    activateSession()
    observeLifecycle()
  }

  /// 锁屏 / 切后台 / 被打断时，如果不是用户自己暂停的，就自动接着读
  private func observeLifecycle() {
    let nc = NotificationCenter.default
    nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      NSLog("[Speech] willResignActive queue=%d speaking=%d paused=%d", self?.queueMode == true ? 1 : 0, self?.synthesizer.isSpeaking == true ? 1 : 0, self?.synthesizer.isPaused == true ? 1 : 0)
    }
    nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      NSLog("[Speech] didEnterBackground queue=%d speaking=%d paused=%d", self?.queueMode == true ? 1 : 0, self?.synthesizer.isSpeaking == true ? 1 : 0, self?.synthesizer.isPaused == true ? 1 : 0)
      self?.resumeIfSystemPaused(after: 0.4)
      self?.resumeIfSystemPaused(after: 1.5)
    }
    nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
      NSLog("[Speech] willEnterForeground queue=%d speaking=%d paused=%d", self?.queueMode == true ? 1 : 0, self?.synthesizer.isSpeaking == true ? 1 : 0, self?.synthesizer.isPaused == true ? 1 : 0)
    }
    nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 99
      NSLog("[Speech] interruption type=%d", Int(type))
      if type == AVAudioSession.InterruptionType.ended.rawValue {
        PlaybackAudioSession.activate()
        self?.resumeIfSystemPaused(after: 0.2)
      }
    }
  }

  private func resumeIfSystemPaused(after delay: TimeInterval) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.queueMode, !self.userPaused, self.synthesizer.isPaused else { return }
      NSLog("[Speech] system paused the queue, resuming")
      PlaybackAudioSession.activate()
      self.synthesizer.continueSpeaking()
      self.setNowPlayingRate(1.0)
    }
  }

  private func activateSession() {
    PlaybackAudioSession.activate()
  }

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

  /// 取消当前一切朗读。先清空 currentUtterances，让随后到来的 didCancel 回调被忽略。
  private func finishAside(cancelled: Bool = false) {
    asideUtterance = nil
    guard let call = asideCall else { return }
    asideCall = nil
    call.keepAlive = false
    call.resolve(["ok": true, "cancelled": cancelled])
  }

  private func stopAsideSynth() {
    finishAside(cancelled: true)
    if asideSynth.isSpeaking || asideSynth.isPaused {
      asideSynth.stopSpeaking(at: .immediate)
    }
  }

  private func cancelAll() {
    stopAsideSynth()
    currentUtterances = []
    finishPending(ok: true, cancelled: true)
    endQueue()
    if synthesizer.isSpeaking || synthesizer.isPaused {
      synthesizer.stopSpeaking(at: .immediate)
    }
  }

  @objc func speakAside(_ call: CAPPluginCall) {
    let text = (call.getString("text") ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      call.resolve(["ok": true, "empty": true])
      return
    }
    finishAside(cancelled: true)
    if asideSynth.isSpeaking || asideSynth.isPaused {
      asideSynth.stopSpeaking(at: .immediate)
    }
    activateSession()
    let voice = resolveVoice(call.getString("voiceId"))
    let utterance = makeUtterance(text, rate: call.getFloat("rate") ?? 0.92, voice: voice, postDelay: 0.02)
    asideUtterance = utterance
    call.keepAlive = true
    asideCall = call
    asideSynth.speak(utterance)
  }

  @objc func stopAside(_ call: CAPPluginCall) {
    stopAsideSynth()
    call.resolve(["ok": true])
  }

  @objc func stop(_ call: CAPPluginCall) {
    cancelAll()
    call.resolve(["ok": true])
  }

  /// 暂停 / 继续当前朗读（全文朗读里「点一下暂停、再点继续」）
  @objc func pause(_ call: CAPPluginCall) {
    if synthesizer.isSpeaking && !synthesizer.isPaused {
      synthesizer.pauseSpeaking(at: .immediate)
    }
    if queueMode { userPaused = true; setNowPlayingRate(0.0) }
    call.resolve(["ok": true])
  }

  @objc func resume(_ call: CAPPluginCall) {
    if synthesizer.isPaused {
      synthesizer.continueSpeaking()
    }
    userPaused = false
    if queueMode { setNowPlayingRate(1.0) }
    call.resolve(["ok": true])
  }

  private func makeUtterance(_ text: String, rate webRate: Float, voice: AVSpeechSynthesisVoice?, postDelay: TimeInterval) -> AVSpeechUtterance {
    let utterance = AVSpeechUtterance(string: text)
    let mapped = AVSpeechUtteranceDefaultSpeechRate * Float(max(0.75, min(1.15, webRate)))
    utterance.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, mapped))
    utterance.pitchMultiplier = 1.0
    utterance.preUtteranceDelay = 0.02
    utterance.postUtteranceDelay = postDelay
    utterance.volume = 1.0
    // 显式使用系统当前默认英文语音（设置里换了就会马上变）
    utterance.voice = voice
    return utterance
  }

  /// 整段全文一次性排队给系统朗读：锁屏/切后台后不依赖网页脚本，也能一句接一句读完。
  @objc func speakQueue(_ call: CAPPluginCall) {
    let rawLines = (call.getArray("lines", String.self) ?? [])
    var lines: [String] = []
    for (i, l) in rawLines.enumerated() {
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
    activateSession()

    let fallbackVoice = resolveVoice(call.getString("voiceId"))
    let voiceIds = call.getArray("voiceIds", String.self) ?? []
    activeVoiceInfo = voiceInfo(fallbackVoice)
    activeVoiceInfo["checkedAt"] = Int(Date().timeIntervalSince1970 * 1000)
    NSLog("[Speech] speakQueue lines=%d voices=%d", lines.count, voiceIds.count)

    var utterances: [AVSpeechUtterance] = []
    for (i, line) in lines.enumerated() {
      let post: TimeInterval = i < lines.count - 1 ? Double(pauseMs) / 1000.0 : 0.04
      let lineVoice = i < voiceIds.count ? resolveVoice(voiceIds[i]) : fallbackVoice
      utterances.append(makeUtterance(line, rate: webRate, voice: lineVoice, postDelay: post))
    }
    currentUtterances = utterances
    queueMode = true
    setIdleTimerDisabled(true)
    beginNowPlaying(title: title)

    call.keepAlive = true
    pendingCall = call
    for u in utterances { synthesizer.speak(u) }
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
  /// 不把封面键清掉，锁屏换句时就不会先露出系统默认白底。
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
      self.synthesizer.continueSpeaking()
      self.setNowPlayingRate(1.0)
      return .success
    }
    center.pauseCommand.addTarget { [weak self] _ in
      guard let self, self.queueMode else { return .noActionableNowPlayingItem }
      self.userPaused = true
      self.synthesizer.pauseSpeaking(at: .word)
      self.setNowPlayingRate(0.0)
      return .success
    }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self, self.queueMode else { return .noActionableNowPlayingItem }
      if self.synthesizer.isPaused {
        self.userPaused = false
        self.synthesizer.continueSpeaking()
        self.setNowPlayingRate(1.0)
      } else {
        self.userPaused = true
        self.synthesizer.pauseSpeaking(at: .word)
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

  @objc func speak(_ call: CAPPluginCall) {
    let text = (call.getString("text") ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      call.resolve(["ok": true, "empty": true])
      return
    }

    cancelAll()
    activateSession()

    // 每次朗读都重新问系统，不沿用上次缓存的音色
    let voice = resolveVoice(call.getString("voiceId"))
    activeVoiceInfo = voiceInfo(voice)
    activeVoiceInfo["checkedAt"] = Int(Date().timeIntervalSince1970 * 1000)

    let webRate = call.getFloat("rate") ?? 0.92
    let utterance = makeUtterance(text, rate: webRate, voice: voice, postDelay: 0.04)
    currentUtterances = [utterance]

    call.keepAlive = true
    pendingCall = call
    synthesizer.speak(utterance)
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

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth { return }
    guard queueMode, let idx = currentUtterances.firstIndex(where: { $0 === utterance }) else { return }
    NSLog("[Speech] didStart %d/%d", idx + 1, currentUtterances.count)
    showNowPlayingLine(utterance.speechString, index: idx + 1, total: currentUtterances.count)
    notifyListeners("queueProgress", data: ["index": idx + 1, "total": currentUtterances.count])
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth {
      if asideUtterance === utterance { finishAside() }
      return
    }
    guard let idx = currentUtterances.firstIndex(where: { $0 === utterance }) else { return }
    if queueMode {
      // 队列：只有最后一句读完才算整段结束
      guard idx == currentUtterances.count - 1 else { return }
      endQueue()
    }
    finishPending(ok: true)
  }

  // 暂停 / 继续（含锁屏界面、耳机触发的），通知网页同步按钮状态
  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth { return }
    guard queueMode, currentUtterances.contains(where: { $0 === utterance }) else { return }
    NSLog("[Speech] didPause userPaused=%d", userPaused ? 1 : 0)
    notifyListeners("queueState", data: ["paused": true])
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth { return }
    guard queueMode, currentUtterances.contains(where: { $0 === utterance }) else { return }
    notifyListeners("queueState", data: ["paused": false])
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    if synthesizer === asideSynth {
      if asideUtterance === utterance { finishAside(cancelled: true) }
      return
    }
    // 被新任务/停止取消的旧 utterance 已不在 currentUtterances 里，直接忽略
    guard currentUtterances.contains(where: { $0 === utterance }) else { return }
    NSLog("[Speech] didCancel (queue ended)")
    endQueue()
    finishPending(ok: true, cancelled: true)
  }
}
