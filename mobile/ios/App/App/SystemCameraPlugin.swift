import Foundation
import UIKit
import Photos
import Capacitor
import MobileCoreServices

/// 调起系统相机 UI（UIImagePickerController）进行录像，完成后写入相册。
/// 注：练习页主路径是网页悬浮窗 getUserMedia；此插件作为原生兜底。
@objc(SystemCameraPlugin)
public class SystemCameraPlugin: CAPPlugin, CAPBridgedPlugin, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  public let identifier = "SystemCameraPlugin"
  public let jsName = "SystemCamera"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "recordVideo", returnType: CAPPluginReturnPromise),
  ]

  private var pendingCall: CAPPluginCall?
  private var picker: UIImagePickerController?

  @objc func recordVideo(_ call: CAPPluginCall) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
        call.reject("此设备没有可用摄像头")
        return
      }
      guard let host = self.bridge?.viewController else {
        call.reject("无法打开系统相机")
        return
      }
      if self.pendingCall != nil {
        call.reject("正在录像中")
        return
      }

      let picker = UIImagePickerController()
      picker.sourceType = .camera
      picker.mediaTypes = [kUTTypeMovie as String]
      picker.cameraCaptureMode = .video
      picker.videoQuality = .typeHigh
      picker.allowsEditing = false
      picker.delegate = self
      if UIImagePickerController.isCameraDeviceAvailable(.front) {
        picker.cameraDevice = .front
      }

      self.pendingCall = call
      self.picker = picker
      host.present(picker, animated: true)
    }
  }

  public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true) { [weak self] in
      self?.pendingCall?.resolve(["ok": false, "cancelled": true])
      self?.pendingCall = nil
      self?.picker = nil
    }
  }

  public func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    let mediaURL = info[.mediaURL] as? URL
    picker.dismiss(animated: true) { [weak self] in
      guard let self else { return }
      guard let mediaURL else {
        self.pendingCall?.resolve(["ok": false, "cancelled": false])
        self.pendingCall = nil
        self.picker = nil
        return
      }
      self.saveVideoToLibrary(mediaURL) { result in
        switch result {
        case .success:
          self.pendingCall?.resolve(["ok": true, "saved": true])
        case .failure(let err):
          self.pendingCall?.resolve([
            "ok": true,
            "saved": false,
            "path": mediaURL.path,
            "error": err.localizedDescription,
          ])
        }
        self.pendingCall = nil
        self.picker = nil
      }
    }
  }

  private func saveVideoToLibrary(_ url: URL, completion: @escaping (Result<Void, Error>) -> Void) {
    PHPhotoLibrary.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async {
          completion(.failure(NSError(
            domain: "SystemCamera",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "没有相册写入权限"]
          )))
        }
        return
      }
      PHPhotoLibrary.shared().performChanges({
        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
      }) { ok, error in
        DispatchQueue.main.async {
          if ok {
            completion(.success(()))
          } else {
            completion(.failure(error ?? NSError(
              domain: "SystemCamera",
              code: 2,
              userInfo: [NSLocalizedDescriptionKey: "保存到相册失败"]
            )))
          }
        }
      }
    }
  }
}
