import Foundation
import Shared

@MainActor
final class DeepLinkRouter: ObservableObject {
    @Published var pending: Destination?

    func handle(_ url: URL) {
        pending = DeepLinks.shared.parse(url: url.absoluteString)
    }
}
