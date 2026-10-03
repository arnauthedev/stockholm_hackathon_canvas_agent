import AppKit
import UniformTypeIdentifiers
import WebKit

protocol WebPaneDelegate: AnyObject {
  func webPane(_ pane: WebPane, stateChanged state: WebPane.State)
  /// A native dialog (file chooser, alert) opened or closed: the panel must not fold under it, nor cover it.
  func webPane(_ pane: WebPane, modalOpen: Bool)
}

/// The web app inside the notch. A WKWebView with persistent storage (the pairing token lives in its
/// localStorage, as on the phone), mic and camera granted to the runner's origin only, the standard file
/// chooser for the Photo button, outside links sent to the default browser, and a `shell` message channel
/// the page uses to report connection, call and typing state (app/src/lib/shell.ts).
final class WebPane: NSView {
  struct State: Equatable {
    var connected = false
    var live = false
    var editing = false
  }

  private(set) var state = State() {
    didSet { if state != oldValue { delegate?.webPane(self, stateChanged: state) } }
  }
  weak var delegate: WebPaneDelegate?
  private(set) var modalOpen = false {
    didSet { if modalOpen != oldValue { delegate?.webPane(self, modalOpen: modalOpen) } }
  }
  let web: WKWebView
  private let message = NSTextField(wrappingLabelWithString: "")
  private var pairing: Pairing?
  private var retry: DispatchWorkItem?

  override init(frame: NSRect) {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    cfg.applicationNameForUserAgent = "CanvasAgentMac/1.0"  // the page switches to its Mac layout on this
    cfg.mediaTypesRequiringUserActionForPlayback = []  // the agent's voice and sounds play without a click
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")  // right-click → Inspect Element
    web = WKWebView(frame: .zero, configuration: cfg)
    super.init(frame: frame)
    cfg.userContentController.add(WeakScriptHandler(self), name: "shell")
    web.uiDelegate = self
    web.navigationDelegate = self
    web.appearance = NSAppearance(named: .darkAqua)  // the panel is black: always the dark theme
    web.setValue(false, forKey: "drawsBackground")  // the panel shows through until the page paints
    web.underPageBackgroundColor = .clear
    web.frame = bounds
    web.autoresizingMask = [.width, .height]
    addSubview(web)
    message.textColor = NSColor.white.withAlphaComponent(0.75)
    message.alignment = .center
    message.font = .systemFont(ofSize: 14)
    message.isHidden = true
    addSubview(message)
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not used") }

  override func layout() {
    super.layout()
    message.frame = NSRect(x: 28, y: bounds.midY - 24, width: bounds.width - 56, height: 48)
  }

  func load(_ p: Pairing) {
    pairing = p
    retry?.cancel()
    show(nil)
    NSLog("loading %@", p.origin.absoluteString)  // never the token
    web.load(URLRequest(url: p.appURL))
  }

  /// Loads the pairing URL again (not `WKWebView.reload`): if the page's storage was ever cleared, the hash re-pairs it.
  func reload() {
    if let pairing { load(pairing) }
  }

  func show(_ text: String?) {
    message.stringValue = text ?? ""
    message.isHidden = text == nil
  }

  private func failed(_ error: Error) {
    let e = error as NSError
    guard e.code != NSURLErrorCancelled else { return }
    NSLog("load failed: %@", e.localizedDescription)
    show("Can't reach the runner: \(e.localizedDescription)\nRetrying…")
    retry?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.reload() }
    retry = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: w)
  }

  private func isOurs(_ o: WKSecurityOrigin) -> Bool {
    guard let p = pairing?.origin else { return false }
    let port = p.port ?? (p.scheme == "https" ? 443 : 80)
    return o.host == p.host && o.protocol == p.scheme && (o.port == port || o.port == 0)
  }
}

extension WebPane: WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any], d["type"] as? String == "state" else { return }
    state = State(connected: d["connected"] as? Bool ?? false, live: d["live"] as? Bool ?? false, editing: d["editing"] as? Bool ?? false)
    NSLog("page state: connected=%d live=%d editing=%d", state.connected, state.live, state.editing)
  }
}

extension WebPane: WKUIDelegate {
  // Mic and camera: macOS asks the user once per app (usage strings in Info.plist); the page gets them for our origin only.
  func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo,
               type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(isOurs(origin) ? .grant : .deny)
  }

  // The Photo button is an <input type=file>: the standard open panel.
  func webView(_ w: WKWebView, runOpenPanelWith params: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
               completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = params.allowsMultipleSelection
    panel.canChooseDirectories = params.allowsDirectories
    panel.allowedContentTypes = [.image]
    panel.message = "Choose a photo to send to the agent"
    modalOpen = true
    NSApp.activate(ignoringOtherApps: true)
    panel.begin { [weak self] r in
      self?.modalOpen = false
      completionHandler(r == .OK ? panel.urls : nil)
    }
  }

  // window.open / target=_blank → the default browser
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url { NSWorkspace.shared.open(u) }
    return nil
  }

  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = msg
    modalOpen = true
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
    modalOpen = false
    completionHandler()
  }

  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = msg
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    modalOpen = true
    NSApp.activate(ignoringOtherApps: true)
    let ok = a.runModal() == .alertFirstButtonReturn
    modalOpen = false
    completionHandler(ok)
  }
}

extension WebPane: WKNavigationDelegate {
  // Links to other sites (open_link) go to the default browser; the panel stays on the app. Iframes (custom cards) are untouched.
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = a.request.url, let p = pairing?.origin, a.targetFrame?.isMainFrame != false,
          ["http", "https"].contains(url.scheme ?? "") else { return decisionHandler(.allow) }
    if url.host != p.host || url.port != p.port {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    if a.targetFrame == nil {  // same origin, new window: stay in the panel
      w.load(a.request)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    retry?.cancel()
    show(nil)
    NSLog("page loaded")
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { failed(e) }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { failed(e) }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { reload() }
}

/// WKUserContentController retains its handlers; this keeps the pane free to deallocate.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ t: WKScriptMessageHandler) { target = t }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    target?.userContentController(c, didReceive: m)
  }
}
