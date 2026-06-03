import SwiftUI
import WidgetKit

@main
struct ScaniWidgetsBundle: WidgetBundle {
    var body: some Widget {
        PortfolioWidget()
        if #available(iOS 17.0, *) {
            AccountWidget()
            HoldingWidget()
            GroupWidget()
            VaultWidget()
        }
    }
}
