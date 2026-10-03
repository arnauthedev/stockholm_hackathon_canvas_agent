import AppKit
import WebKit

/// Debug aid: `--snapshot <dir>` writes `<dir>/panel.png` shortly after launch, rendered in-process (the notch
/// shape from the layer tree, the page from the web view's own snapshot). Screen capture from a terminal needs
/// a permission it usually lacks; this does not.
enum Snapshot {
  static func schedule(_ notch: NotchController, dir: String) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
      notch.expand(hold: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { write(notch, dir: dir) }
    }
  }

  private static func write(_ notch: NotchController, dir: String) {
    let view = notch.view
    let size = view.bounds.size
    guard size.width > 0, size.height > 0 else { return NSLog("snapshot: empty view") }
    let img = NSImage(size: size)
    img.lockFocusFlipped(true)
    if let ctx = NSGraphicsContext.current?.cgContext { view.layer?.render(in: ctx) }
    img.unlockFocus()
    let contentFrame = view.content.frame
    notch.pane.web.takeSnapshot(with: nil) { page, err in
      if let page {
        img.lockFocusFlipped(true)
        page.draw(in: contentFrame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        img.unlockFocus()
      } else {
        NSLog("snapshot: no page image (%@)", err?.localizedDescription ?? "?")
      }
      guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:]) else { return NSLog("snapshot: encode failed") }
      save(png, to: dir, name: "panel.png")
      notch.collapse()
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { writePill(notch, dir: dir) }
    }
  }

  private static func writePill(_ notch: NotchController, dir: String) {
    let view = notch.view
    let img = NSImage(size: view.bounds.size)
    img.lockFocusFlipped(true)
    if let ctx = NSGraphicsContext.current?.cgContext { view.layer?.render(in: ctx) }
    img.unlockFocus()
    if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
      save(png, to: dir, name: "pill.png")
    }
  }

  private static func save(_ png: Data, to dir: String, name: String) {
    let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
    do {
      try png.write(to: url)
      NSLog("snapshot written: %@", url.path)
    } catch {
      NSLog("snapshot: %@", error.localizedDescription)
    }
  }
}
