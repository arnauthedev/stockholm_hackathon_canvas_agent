import AppKit

// Agent app: lives in the menu bar and the notch, never in the Dock.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
