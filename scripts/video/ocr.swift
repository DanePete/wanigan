// Read the text in images with Apple's Vision framework, for the privacy check
// of finished footage. Prints one JSON line per image: {"file", "lines"}.
//   swiftc -O scripts/video/ocr.swift -o .artifacts/video/bin/ocr   (review.mjs does this)
import AppKit
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
  guard let image = NSImage(contentsOfFile: path),
        let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
    continue
  }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.minimumTextHeight = 0.008
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  try? handler.perform([request])
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  let object: [String: Any] = ["file": path, "lines": lines]
  if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
    print(text)
  }
}
