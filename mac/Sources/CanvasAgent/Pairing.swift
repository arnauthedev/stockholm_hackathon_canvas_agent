import Foundation

/// Where the runner is and how to authenticate: the same pairing link the phone scans (`https://host/#token=…`).
struct Pairing: Equatable {
  let origin: URL  // scheme://host[:port]
  let token: String

  /// Parses a pairing link. Returns nil for anything without a `#token=` of a plausible length.
  static func parse(_ raw: String) -> Pairing? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: s), let scheme = url.scheme, let host = url.host, let frag = url.fragment,
          let m = frag.range(of: "token=") else { return nil }
    var t = String(frag[m.upperBound...])
    if let amp = t.firstIndex(of: "&") { t = String(t[..<amp]) }
    guard let token = t.removingPercentEncoding, token.count >= 16 else { return nil }
    var origin = "\(scheme)://\(host)"
    if let port = url.port { origin += ":\(port)" }
    guard let o = URL(string: origin) else { return nil }
    return Pairing(origin: o, token: token)
  }

  var link: String { "\(origin.absoluteString)/#token=\(token)" }
  /// What the web view loads. The token travels once in the hash; the page stores it and strips it, like on the phone.
  var appURL: URL { URL(string: link)! }

  // Kept in UserDefaults: a local runner secret for one user on one machine. The Keychain would ask for
  // approval after every ad-hoc rebuild, which is every `mac/build.sh`.
  private static let key = "pairingLink"
  static func load() -> Pairing? { UserDefaults.standard.string(forKey: key).flatMap(parse) }
  func save() { UserDefaults.standard.set(link, forKey: Pairing.key) }

  /// GET /api/health with the token; the result arrives on the main thread.
  func check(_ done: @escaping (Result<Void, Error>) -> Void) {
    var req = URLRequest(url: origin.appendingPathComponent("api/health"), timeoutInterval: 8)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    URLSession.shared.dataTask(with: req) { _, resp, err in
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      let r: Result<Void, Error>
      if let err { r = .failure(err) }
      else if (200..<300).contains(status) { r = .success(()) }
      else { r = .failure(NSError(domain: "pairing", code: status, userInfo: [NSLocalizedDescriptionKey: status == 401 ? "wrong token" : "HTTP \(status)"])) }
      DispatchQueue.main.async { done(r) }
    }.resume()
  }
}
