import Cocoa
import AVFoundation
import Speech

final class Dictation {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var generation = 0
    private var tapped = false

    func cancel() {
        generation += 1
        if engine.isRunning { engine.stop() }
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        request?.endAudio()
        task?.cancel()
        request = nil; task = nil; recognizer = nil
    }
    func finish() -> Bool {
        guard request != nil else { cancel(); return false }
        if engine.isRunning { engine.stop() }
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        request?.endAudio()
        return true
    }
    func start(report: @escaping (String, Bool, String?) -> Void) {
        cancel()
        let current = generation
        SFSpeechRecognizer.requestAuthorization { permission in
            DispatchQueue.main.async {
                guard self.generation == current else { return }
                guard permission == .authorized else { self.cancel(); report("", true, "Allow speech recognition in System Settings to dictate."); return }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard self.generation == current else { return }
                        guard granted else { self.cancel(); report("", true, "Allow microphone access in System Settings to dictate."); return }
                        do { try self.listen(current, report: report) }
                        catch { self.cancel(); report("", true, error.localizedDescription) }
                    }
                }
            }
        }
    }
    private func listen(_ current: Int, report: @escaping (String, Bool, String?) -> Void) throws {
        guard let service = SFSpeechRecognizer(locale: Locale.current), service.isAvailable else {
            throw NSError(domain: "Dictation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech recognition is unavailable for this language."])
        }
        recognizer = service
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw NSError(domain: "Dictation", code: 2, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
        }
        let audio = SFSpeechAudioBufferRecognitionRequest()
        if service.supportsOnDeviceRecognition { audio.requiresOnDeviceRecognition = true }
        audio.shouldReportPartialResults = true
        request = audio
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in audio.append(buffer) }
        tapped = true
        task = service.recognitionTask(with: audio) { result, error in
            DispatchQueue.main.async {
                guard self.generation == current else { return }
                let done = result?.isFinal == true || error != nil
                report(result?.bestTranscription.formattedString ?? "", done, error?.localizedDescription)
                if done { self.cancel() }
            }
        }
        engine.prepare()
        try engine.start()
    }
}
