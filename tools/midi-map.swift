// Guided MIDI mapping from the Terminal (CoreMIDI), for when the browser's MIDI Learn
// cannot be used. Prompts for each control, records what it sends, and writes a mapping
// file for the app's MIDI panel (Mappings → Import).
//
//   swiftc -O tools/midi-map.swift -o /tmp/midi-map && /tmp/midi-map tools/midi-steps.json nomad-midi-mapping.json
//
// Same rules as the app's guided setup: the control mapped in the previous step is ignored
// (the rest of a knob turn, a button release), knobs/faders must send CC, buttons must be
// pressed, and jogs/encoders are watched for a moment to tell an encoder from a strip.
import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

struct Step: Decodable { let device: String; let prompt: String; let targetId: String; let kind: String }
struct Msg { let t: Double; let source: String; let type: String; let channel: Int; let number: Int; let value: Int }

let args = CommandLine.arguments
guard args.count >= 3, let data = FileManager.default.contents(atPath: args[1]), let steps = try? JSONDecoder().decode([Step].self, from: data) else {
  print("usage: midi-map <steps.json> <output.json>"); exit(1)
}
let outPath = args[2]
let relValues: Set<Int> = [1, 2, 3, 4, 5, 6, 7, 121, 122, 123, 124, 125, 126, 127, 63, 65]

// ---- MIDI input: every message from every source into a locked queue ----
let lock = NSLock()
var queue: [Msg] = []
let t0 = Date()
func now() -> Double { Date().timeIntervalSince(t0) }
func name(_ o: MIDIObjectRef) -> String { var s: Unmanaged<CFString>?; MIDIObjectGetStringProperty(o, kMIDIPropertyDisplayName, &s); return (s?.takeRetainedValue() as String?) ?? "?" }

var client = MIDIClientRef(); MIDIClientCreateWithBlock("nomad-map" as CFString, &client, nil)
var port = MIDIPortRef()
MIDIInputPortCreateWithBlock(client, "in" as CFString, &port) { list, src in
  let source = src.map { Unmanaged<NSString>.fromOpaque($0).takeUnretainedValue() as String } ?? "?"
  var p = list.pointee.packet
  for _ in 0..<list.pointee.numPackets {
    let bytes = withUnsafeBytes(of: p.data) { Array($0.prefix(Int(p.length))) }
    var i = 0
    while i < bytes.count {
      let st = bytes[i]
      if st < 0x80 { i += 1; continue }
      let hi = st & 0xF0
      let len = (hi == 0xC0 || hi == 0xD0) ? 2 : (hi >= 0xF0 ? 1 : 3)
      if (hi == 0x80 || hi == 0x90 || hi == 0xB0) && i + 2 < bytes.count {
        let v = hi == 0x80 ? 0 : Int(bytes[i + 2])
        let m = Msg(t: now(), source: source, type: hi == 0xB0 ? "cc" : "note", channel: Int(st & 0x0F), number: Int(bytes[i + 1]), value: v)
        lock.lock(); queue.append(m); lock.unlock()
      }
      i += len
    }
    p = MIDIPacketNext(&p).pointee
  }
}
var sources: [String] = []
for i in 0..<MIDIGetNumberOfSources() {
  let s = MIDIGetSource(i); let n = name(s)
  MIDIPortConnectSource(port, s, Unmanaged.passRetained(n as NSString).toOpaque())
  sources.append(n)
}
print("MIDI inputs: \(sources.joined(separator: ", "))")
for dev in Set(steps.map { $0.device }).sorted() where !sources.contains(where: { $0.lowercased().contains(dev.lowercased()) }) {
  print("⚠️  No \(dev) found. Check the USB cable and that it is in MIDI mode.")
}

func take() -> [Msg] { lock.lock(); defer { lock.unlock() }; let q = queue; queue.removeAll(); return q }
func wait(_ s: Double) { RunLoop.current.run(until: Date().addingTimeInterval(s)) }

// ---- mapping file ----
var mappings: [[String: Any]] = []
func save() {
  let doc: [String: Any] = ["app": "nomad-mixer", "version": 1, "mappings": mappings]
  if let d = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]) { FileManager.default.createFile(atPath: outPath, contents: d) }
}
func key(_ m: Msg) -> String { "\(m.source)|\(m.type)|\(m.channel)|\(m.number)" }

// ---- guided steps ----
var ignoreKey: String? = nil
var ignoreUntil = 0.0
var skipped: [String] = []
print("\nMove each control when it is named. 45 s per step, then it is skipped.\n")
for (idx, step) in steps.enumerated() {
  print(String(format: "[%2d/%d] %@ – %@", idx + 1, steps.count, step.device, step.prompt), terminator: "  … ")
  fflush(stdout) // the prompt has no line break yet: show it now
  _ = take() // drop anything from before this prompt
  let deadline = now() + 45
  var done = false
  var samples: [Msg] = []
  var sampleEnd = 0.0
  while !done && now() < deadline {
    wait(0.01)
    for m in take() {
      if done { break }
      if !m.source.lowercased().contains(step.device.lowercased()) { continue } // wrong controller
      if m.t < ignoreUntil || key(m) == ignoreKey { continue }
      switch step.kind {
      case "press":
        if m.value == 0 { continue }
        mappings.append(["input": m.source, "type": m.type, "channel": m.channel, "number": m.number, "targetId": step.targetId, "enc": "abs"])
        ignoreKey = key(m); done = true
      case "absolute":
        if m.type != "cc" { continue } // knobs and faders send CC; skip button bleed
        mappings.append(["input": m.source, "type": m.type, "channel": m.channel, "number": m.number, "targetId": step.targetId, "enc": "abs"])
        ignoreKey = key(m); done = true
      default: // relative: jog / encoder / strip
        if m.type != "cc" { continue }
        if let f = samples.first, key(f) != key(m) { continue }
        if samples.isEmpty { sampleEnd = m.t + 0.45 }
        samples.append(m)
      }
    }
    if step.kind == "relative" && !samples.isEmpty && now() >= sampleEnd {
      let f = samples[0]
      let enc = samples.allSatisfy { relValues.contains($0.value) } ? "rel" : "absdelta"
      mappings.append(["input": f.source, "type": f.type, "channel": f.channel, "number": f.number, "targetId": step.targetId, "enc": enc])
      ignoreKey = key(f); done = true
    }
  }
  if done, let m = mappings.last {
    ignoreUntil = now() + 0.15
    print("✓ \(m["type"] as! String == "cc" ? "CC" : "Note") \(m["number"]!) ch \((m["channel"] as! Int) + 1)\((m["enc"] as! String) == "abs" ? "" : " (\(m["enc"]!))")")
  } else {
    skipped.append(step.prompt)
    print("skipped (nothing received)")
  }
  save()
  wait(0.25) // let the hand come off the control
}
print("\nSaved \(mappings.count) mappings to \(outPath)")
if !skipped.isEmpty { print("Skipped: \(skipped.joined(separator: "; "))") }
print("In the app: MIDI → Mappings → Import, then choose this file.")
