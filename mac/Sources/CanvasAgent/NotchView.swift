import AppKit

/// The notch-shaped backdrop: black, flaring into the screen edge at the top like the Dynamic Island, rounded
/// at the bottom. Hosts the web pane below the notch strip, and a status dot while folded.
final class NotchView: NSView {
  static let flare: CGFloat = 10
  /// The physical notch (or the menu bar) height: content starts below it.
  var stripHeight: CGFloat = 32 { didSet { needsLayout = true } }
  var cornerRadius: CGFloat = 12 { didSet { needsLayout = true } }
  var collapsed = true { didSet { needsLayout = true } }
  var dotColor: NSColor = .systemRed { didSet { dot.backgroundColor = dotColor.cgColor } }
  var dotPulsing = false { didSet { pulse() } }
  var onMouseDown: ((NSPoint) -> Void)?
  var onHover: ((Bool) -> Void)?

  /// Where the web pane lives; clipped to the rounded bottom. Flipped, so the pane stays anchored to the top while the panel grows.
  let content = FlippedView()
  private let fill = CAShapeLayer()
  private let stroke = CAShapeLayer()
  private let dot = CALayer()

  override var isFlipped: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    fill.fillColor = NSColor.black.cgColor
    stroke.fillColor = nil
    stroke.strokeColor = NSColor.white.withAlphaComponent(0.14).cgColor
    stroke.lineWidth = 1
    dot.backgroundColor = dotColor.cgColor
    dot.bounds = CGRect(x: 0, y: 0, width: 7, height: 7)
    dot.cornerRadius = 3.5
    layer?.addSublayer(fill)
    layer?.addSublayer(stroke)
    layer?.addSublayer(dot)
    content.wantsLayer = true
    content.layer?.masksToBounds = true
    addSubview(content)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not used") }

  override func setFrameSize(_ s: NSSize) {
    super.setFrameSize(s)
    needsLayout = true
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)  // the window frame animation drives the shape; no second animation
    let f = NotchView.flare
    let path = notchPath(in: bounds)
    fill.path = path
    stroke.path = path
    content.frame = CGRect(x: f, y: stripHeight, width: bounds.width - 2 * f, height: max(0, bounds.height - stripHeight))
    content.layer?.cornerRadius = cornerRadius
    content.isHidden = collapsed
    dot.isHidden = !collapsed
    dot.position = CGPoint(x: bounds.width - f - 16, y: stripHeight / 2)
    CATransaction.commit()
  }

  private func notchPath(in b: CGRect) -> CGPath {
    let f = NotchView.flare, w = b.width, h = b.height
    let r = min(cornerRadius, (h - f) / 2)
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 0, y: 0))
    p.addQuadCurve(to: CGPoint(x: f, y: f), control: CGPoint(x: f, y: 0))
    p.addLine(to: CGPoint(x: f, y: h - r))
    p.addQuadCurve(to: CGPoint(x: f + r, y: h), control: CGPoint(x: f, y: h))
    p.addLine(to: CGPoint(x: w - f - r, y: h))
    p.addQuadCurve(to: CGPoint(x: w - f, y: h - r), control: CGPoint(x: w - f, y: h))
    p.addLine(to: CGPoint(x: w - f, y: f))
    p.addQuadCurve(to: CGPoint(x: w, y: 0), control: CGPoint(x: w - f, y: 0))
    p.closeSubpath()
    return p
  }

  private func pulse() {
    dot.removeAnimation(forKey: "pulse")
    guard dotPulsing else { return }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 1
    a.toValue = 0.2
    a.duration = 0.7
    a.autoreverses = true
    a.repeatCount = .infinity
    dot.add(a, forKey: "pulse")
  }

  override func mouseEntered(with e: NSEvent) { onHover?(true) }
  override func mouseExited(with e: NSEvent) { onHover?(false) }
  override func mouseDown(with e: NSEvent) { onMouseDown?(convert(e.locationInWindow, from: nil)) }
}

final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}
