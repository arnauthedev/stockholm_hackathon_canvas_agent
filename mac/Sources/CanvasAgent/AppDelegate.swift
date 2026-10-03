import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var notch: NotchController!
  private var status: NSStatusItem!
  private let toggleItem = NSMenuItem(title: "Open", action: #selector(toggle), keyEquivalent: "")

  func applicationDidFinishLaunching(_ n: Notification) {
    notch = NotchController()
    makeStatusItem()
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--pair"), i + 1 < args.count, let p = Pairing.parse(args[i + 1]) {
      p.save()
      notch.pane.load(p)
      notch.expand(hold: true)
    } else if let p = Pairing.load() {
      notch.pane.load(p)
    } else {
      notch.pane.show("Not paired yet.")
      askToPair()
    }
    if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { Snapshot.schedule(notch, dir: args[i + 1]) }
  }

  private func makeStatusItem() {
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    status.button?.image = NSImage(systemSymbolName: "rectangle.topthird.inset.filled", accessibilityDescription: "Canvas Agent")
    let menu = NSMenu()
    menu.delegate = self
    toggleItem.target = self
    menu.addItem(toggleItem)
    menu.addItem(item("Reload", #selector(reload)))
    menu.addItem(item("Open in Browser", #selector(openInBrowser)))
    menu.addItem(.separator())
    menu.addItem(item("Pair…", #selector(pairMenu)))
    menu.addItem(.separator())
    menu.addItem(item("Quit Canvas Agent", #selector(quit), key: "q"))
    status.menu = menu
  }

  private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.target = self
    return i
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    toggleItem.title = notch.expanded ? "Fold" : "Open"
  }

  @objc private func toggle() { notch.toggle() }
  @objc private func reload() { notch.pane.reload() }
  @objc private func pairMenu() { askToPair() }
  @objc private func quit() { NSApp.terminate(nil) }
  @objc private func openInBrowser() {
    if let p = Pairing.load(), let u = URL(string: p.link) { NSWorkspace.shared.open(u) }
  }

  /// The same step as the phone: paste the pairing link once. Prefilled from the clipboard when it holds one.
  private func askToPair() {
    let alert = NSAlert()
    alert.messageText = "Pair with your Canvas Agent"
    alert.informativeText = "Paste the pairing link printed by scripts/matrix-pair.sh or scripts/dev.sh."
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 24))
    field.placeholderString = "https://…/#token=…"
    if let s = NSPasteboard.general.string(forType: .string), Pairing.parse(s) != nil {
      field.stringValue = s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    alert.accessoryView = field
    alert.addButton(withTitle: "Pair")
    alert.addButton(withTitle: Pairing.load() == nil ? "Quit" : "Cancel")
    alert.window.initialFirstResponder = field
    notch.collapse()
    notch.dialogOpen(true)
    NSApp.activate(ignoringOtherApps: true)
    let r = alert.runModal()
    notch.dialogOpen(false)
    guard r == .alertFirstButtonReturn else {
      if Pairing.load() == nil { NSApp.terminate(nil) }
      return
    }
    guard let p = Pairing.parse(field.stringValue) else { return failed("That isn't a pairing link.") }
    notch.pane.show("Checking \(p.origin.host ?? "the runner")…")
    p.check { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        p.save()
        self.notch.pane.load(p)
        self.notch.expand(hold: true)
      case .failure(let e):
        self.failed("\(p.origin.absoluteString) didn't answer: \(e.localizedDescription)")
      }
    }
  }

  private func failed(_ text: String) {
    let a = NSAlert()
    a.messageText = "Pairing failed"
    a.informativeText = text
    a.addButton(withTitle: "Try again")
    a.addButton(withTitle: "Cancel")
    notch.dialogOpen(true)
    NSApp.activate(ignoringOtherApps: true)
    let r = a.runModal()
    notch.dialogOpen(false)
    if r == .alertFirstButtonReturn { askToPair() }
    else if Pairing.load() == nil { notch.pane.show("Not paired. Menu bar icon → Pair…") }
  }
}
