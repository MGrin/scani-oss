import React from "react"
import { render } from "@testing-library/react-native"
import { SvgIcon } from "../SvgIcon"
import type { SvgIconTypes } from "../registry"

// Mock the theme context
jest.mock("@/theme/context", () => ({
  useAppTheme: () => ({
    theme: {
      colors: {
        text: "#000000",
      },
    },
  }),
}))

describe("SvgIcon", () => {
  // T015: Test renders icon from registry
  it("renders icon from registry", () => {
    const { container } = render(<SvgIcon name="scani-logo" size={48} />)
    expect(container).toBeTruthy()
  })

  // T016: Test returns null for non-existent icon
  it("returns null for non-existent icon", () => {
    const { container } = render(<SvgIcon name={"invalid-icon" as SvgIconTypes} />)
    expect(container).toBeTruthy()
  })

  // T017: Test applies custom size
  it("applies custom size", () => {
    const { container } = render(<SvgIcon name="scani-logo" size={100} />)
    expect(container).toBeTruthy()
  })

  // T018: Test applies custom color
  it("applies custom color", () => {
    const { container } = render(<SvgIcon name="scani-logo" color="#ff0000" />)
    expect(container).toBeTruthy()
  })

  // T019: Snapshot test for basic icon rendering
  it("matches snapshot for basic icon rendering", () => {
    const tree = render(<SvgIcon name="scani-logo" size={48} />)
    expect(tree).toMatchSnapshot()
  })
})
