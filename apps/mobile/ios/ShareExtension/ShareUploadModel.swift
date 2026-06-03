import Foundation
import Shared

@MainActor
final class ShareUploadModel: ObservableObject {
    @Published var accounts: [MobileAccount] = []
    @Published var selectedAccountId: String? = nil
    @Published var isUploading = false
    @Published var errorMessage: String? = nil
    @Published var isSignedIn: Bool

    let imageData: Data?
    let contentType: String

    var onComplete: (() -> Void)?
    var onCancel: (() -> Void)?

    private let cookieJar: PersistentCookiesStorage
    private let uploadService: ScreenshotUploadService
    private let mobileApi: MobileApi

    init(
        imageData: Data?,
        contentType: String,
        cookieJar: PersistentCookiesStorage,
        uploadService: ScreenshotUploadService,
        mobileApi: MobileApi
    ) {
        self.imageData = imageData
        self.contentType = contentType
        self.cookieJar = cookieJar
        self.uploadService = uploadService
        self.mobileApi = mobileApi
        self.isSignedIn = cookieJar.hasAnyCookie()
    }

    func loadAccounts() {
        Task {
            do {
                accounts = try await mobileApi.accounts()
            } catch {}
        }
    }

    func upload() {
        guard let data = imageData else {
            errorMessage = "No image found."
            return
        }
        isUploading = true
        errorMessage = nil
        Task {
            do {
                try await uploadService.upload(
                    image: data.toKotlinByteArray(),
                    fileName: "screenshot.png",
                    contentType: contentType,
                    accountId: selectedAccountId
                )
                onComplete?()
            } catch {
                errorMessage = error.localizedDescription
                isUploading = false
            }
        }
    }

    func cancel() {
        onCancel?()
    }
}

private extension Data {
    func toKotlinByteArray() -> KotlinByteArray {
        let array = KotlinByteArray(size: Int32(count))
        for (i, byte) in enumerated() {
            array.set(index: Int32(i), value: Int8(bitPattern: byte))
        }
        return array
    }
}
