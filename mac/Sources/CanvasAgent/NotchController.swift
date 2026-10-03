import AppKit

/// The notch window: borderless, above the menu bar, on every Space and over full-screen apps. It never
/// activates the app, but can take the keyboard so the Text sheet works.
final class NotchPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  /// AppKit keeps windows below the menu bar; the notch is exactly there.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// Owns the notch panel: where it sits, when it opens and folds, and what the folded pill signals.
///
/// Folded, it is a black pill hugging the notch with a status dot (red offline, green connected, pulsing
/// accent during a call). Hovering opens it; leaving folds it again, unless the user clicked it open, is
/// typing, or has a file chooser up. Esc, a click on the notch strip, or a click anywhere outside folds it.
final class NotchController: NSObject, WebPaneDelegate {
  static let expandedSize = NSSize(width: 640, height: 560)
  static let sidePad: CGFloat = 26  // black margin beside the notch while folded

  let panel: NotchPanel
  let view = NotchView(frame: .zero)
  let pane = WebPane(frame: .zero)
  private(set) var expanded = false
  private var held = false
  private var hoverTimer: Timer?
  private var monitors: [Any] = []

  override init() {
    panel = NotchPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    super.init()
    panel.level = .screenSaver  // above the menu bar and full-screen apps
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovable = false
    panel.animationBehavior = .none
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.contentView = view
    view.content.addSubview(pane)
    pane.delegate = self
    view.onHover = { [weak self] inside in self?.hover(inside) }
    view.onMouseDown = { [weak self] p in self?.click(at: p) }
    relayout()
    panel.orderFrontRegardless()
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in self?.clickedOutside() }) {
      monitors.append(m)
    }
    if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
      // Esc folds. A page that handles Esc itself gets it first and sends `fold` once nothing is open.
      guard let self, e.keyCode == 53, self.expanded, !self.pane.state.handlesEsc else { return e }
      self.collapse()
      return nil
    }) {
      monitors.append(m)
    }
    NotificationCenter.default.addObserver(self, selector: #selector(relayout), name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }

  // MARK: geometry

  /// The screen with the notch, else the main one.
  private var screen: NSScreen {
    NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main ?? NSScreen.screens[0]
  }

  private var stripHeight: CGFloat {
    let s = screen
    return s.safeAreaInsets.top > 0 ? s.safeAreaInsets.top : max(24, s.frame.maxY - s.visibleFrame.maxY)
  }

  private var notchWidth: CGFloat {
    let s = screen
    if let l = s.auxiliaryTopLeftArea, let r = s.auxiliaryTopRightArea { return r.minX - l.maxX }
    return 180  // no notch: a pill of this width at the top centre
  }

  private func frame(expanded: Bool) -> NSRect {
    let s = screen, f = NotchView.flare
    let size = expanded ? NotchController.expandedSize : NSSize(width: notchWidth + 2 * NotchController.sidePad, height: stripHeight)
    let w = size.width + 2 * f
    return NSRect(x: (s.frame.midX - w / 2).rounded(), y: s.frame.maxY - size.height, width: w, height: size.height)
  }

  /// Screen changed (display plugged, resolution): put everything back without animating.
  @objc private func relayout() {
    view.stripHeight = stripHeight
    // The pane keeps its full size and is revealed by the growing panel, so the page never re-lays out mid-animation.
    pane.frame = CGRect(x: 0, y: 0, width: NotchController.expandedSize.width, height: NotchController.expandedSize.height - stripHeight)
    setExpanded(expanded, animated: false)
  }

  private func setExpanded(_ on: Bool, animated: Bool) {
    if on != expanded { NSLog(on ? "open" : "fold") }
    expanded = on
    view.cornerRadius = on ? 22 : 12
    if on { view.collapsed = false }  // show the content as the panel grows; hide it after it has shrunk
    let target = frame(expanded: on)
    pane.setFolded(!on)
    guard animated else {
      panel.setFrame(target, display: true)
      view.collapsed = !on
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = on ? 0.34 : 0.26
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
      self.panel.animator().setFrame(target, display: true)
    }, completionHandler: { [weak self] in
      guard let self else { return }
      if !on && !self.expanded { self.view.collapsed = true }
      self.panel.invalidateShadow()
    })
  }

  // MARK: open / fold

  private var mustStayOpen: Bool { held || pane.state.editing || pane.modalOpen }
  /// Tolerant: a cursor pinned to the top edge of the screen reads as y == maxY, just outside the frame.
  private var mouseInside: Bool { panel.frame.insetBy(dx: -4, dy: -4).contains(NSEvent.mouseLocation) }

  func expand(hold: Bool) {
    hoverTimer?.invalidate()
    held = held || hold
    if !expanded { setExpanded(true, animated: true) }
  }

  func collapse() {
    hoverTimer?.invalidate()
    held = false
    guard expanded else { return }
    setExpanded(false, animated: true)
    // Folded with a field focused, keystrokes would still land in the page: blur it and give the keyboard back.
    pane.web.evaluateJavaScript("document.activeElement && document.activeElement.blur()")
    if panel.isKeyWindow {
      panel.orderOut(nil)
      panel.orderFrontRegardless()
    }
  }

  func toggle() {
    if expanded { collapse() } else { expand(hold: true) }
  }

  private func hover(_ inside: Bool) {
    hoverTimer?.invalidate()
    NSLog(inside ? "hover in" : "hover out")
    if inside {
      guard !expanded else { return }
      // No position check here: the tracking area said the cursor is in, and leaving cancels this timer.
      hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { [weak self] _ in
        self?.expand(hold: false)
      }
    } else {
      guard expanded, !mustStayOpen else { return }
      hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
        guard let self, self.expanded, !self.mustStayOpen, !self.mouseInside else { return }
        self.collapse()
      }
    }
  }

  /// A click on the backdrop (the web pane handles its own): the pill opens, the notch strip of the open panel folds it.
  private func click(at p: NSPoint) {
    if !expanded { expand(hold: true) }
    else if p.y <= view.stripHeight + 4 { collapse() }
  }

  private func clickedOutside() {
    if expanded { collapse() }
  }

  // MARK: WebPaneDelegate

  func webPane(_ pane: WebPane, stateChanged s: WebPane.State) {
    view.dotColor = s.live ? .controlAccentColor : (s.connected ? .systemGreen : .systemRed)
    view.dotPulsing = s.live
    if s.editing, expanded, !panel.isKeyWindow { panel.makeKey() }
  }

  /// Dialogs (file chooser, alerts) are ordinary windows: while one is up the panel steps down to their level so it cannot cover them.
  func webPane(_ pane: WebPane, modalOpen: Bool) { dialogOpen(modalOpen) }

  func webPaneRequestsFold(_ pane: WebPane) { collapse() }

  func dialogOpen(_ open: Bool) {
    panel.level = open ? .normal : .screenSaver
  }
}
