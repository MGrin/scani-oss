import UIKit
import SwiftUI
import UniformTypeIdentifiers
import Shared

final class ShareViewController: UIViewController {
    private let baseURL = "http://localhost:3001"

    override func viewDidLoad() {
        super.viewDidLoad()
        extractImage { [weak self] imageData, contentType in
            guard let self else { return }
            DispatchQueue.main.async {
                self.presentUploadUI(imageData: imageData, contentType: contentType)
            }
        }
    }

    private func extractImage(completion: @escaping (Data?, String) -> Void) {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let provider = item.attachments?.first else {
            completion(nil, "image/png")
            return
        }
        let pngType = UTType.png.identifier
        let jpegType = UTType.jpeg.identifier
        let imageType = UTType.image.identifier

        let preferredType: String
        if provider.hasItemConformingToTypeIdentifier(pngType) {
            preferredType = pngType
        } else if provider.hasItemConformingToTypeIdentifier(jpegType) {
            preferredType = jpegType
        } else {
            preferredType = imageType
        }

        let contentType = preferredType == jpegType ? "image/jpeg" : "image/png"

        provider.loadDataRepresentation(forTypeIdentifier: preferredType) { data, _ in
            completion(data, contentType)
        }
    }

    private func presentUploadUI(imageData: Data?, contentType: String) {
        let storage = KeychainSecureStorage()
        let cookieJar = PersistentCookiesStorage(storage: storage)
        let http = HttpClientFactoryKt.createScaniHttpClient(
            engine: HttpEngine_iosKt.defaultHttpEngine(),
            cookieStorage: cookieJar,
            onUnauthorized: {}
        )
        let trpc = TrpcClient(http: http, baseUrl: baseURL)
        let uploadService = ScreenshotUploadService(http: http, trpc: trpc, genId: { UUID().uuidString })
        let mobileApi = MobileApi(client: trpc)

        let model = ShareUploadModel(
            imageData: imageData,
            contentType: contentType,
            cookieJar: cookieJar,
            uploadService: uploadService,
            mobileApi: mobileApi
        )
        model.onComplete = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: [])
        }
        model.onCancel = { [weak self] in
            self?.extensionContext?.cancelRequest(withError: NSError(domain: "xyz.scani.mobile", code: 0))
        }

        let hostingController = UIHostingController(rootView: ShareUploadView(model: model))
        addChild(hostingController)
        view.addSubview(hostingController.view)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        hostingController.didMove(toParent: self)
    }
}
