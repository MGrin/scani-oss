import Foundation

func syncStatusLabel(_ millis: Int64?) -> String {
    guard let millis else { return "Never synced" }
    let date = Date(timeIntervalSince1970: Double(millis) / 1000.0)
    let f = DateFormatter()
    f.dateFormat = "MMM d, HH:mm"
    return "Last synced: \(f.string(from: date))"
}
