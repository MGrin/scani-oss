import SwiftUI

private let swatchHexValues = [
    "#3B82F6", "#22C55E", "#EF4444", "#F59E0B",
    "#8B5CF6", "#EC4899", "#14B8A6", "#64748B"
]

extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s = String(s.dropFirst()) }
        guard s.count == 6, let value = UInt64(s, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

struct ColorSwatchPicker: View {
    @Binding var selected: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(swatchHexValues, id: \.self) { hex in
                    let isSelected = selected == hex
                    Circle()
                        .fill(Color(hex: hex) ?? .gray)
                        .frame(width: 28, height: 28)
                        .overlay(
                            Circle()
                                .strokeBorder(.white, lineWidth: isSelected ? 2 : 0)
                                .padding(2)
                        )
                        .overlay(
                            Circle()
                                .strokeBorder(Color(hex: hex) ?? .gray, lineWidth: isSelected ? 2 : 0)
                        )
                        .onTapGesture { selected = hex }
                }
            }
            .padding(.vertical, 4)
        }
    }
}
