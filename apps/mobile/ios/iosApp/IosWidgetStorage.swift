import Foundation
import Shared

final class IosWidgetStorage: WidgetStorage {
    private let fileURL: URL? = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: "group.xyz.scani.mobile")?
        .appendingPathComponent("widget.json")

    func write(json: String) {
        guard let url = fileURL, let data = json.data(using: .utf8) else { return }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            // File write failure is non-fatal — widget shows stale data
            print("[IosWidgetStorage] write failed: \(error)")
        }
    }
}
