import SwiftUI
import Shared

struct ShareUploadView: View {
    @ObservedObject var model: ShareUploadModel

    var body: some View {
        NavigationView {
            if !model.isSignedIn {
                notSignedInView
            } else {
                uploadView
            }
        }
    }

    private var notSignedInView: some View {
        VStack(spacing: 16) {
            Text("Open Scani and sign in first.")
                .multilineTextAlignment(.center)
                .padding()
            Button("Cancel") { model.cancel() }
                .foregroundColor(.red)
        }
        .navigationTitle("Scani")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var uploadView: some View {
        VStack(spacing: 16) {
            if let data = model.imageData, let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240)
                    .cornerRadius(8)
                    .padding(.horizontal)
            }

            if !model.accounts.isEmpty {
                Picker("Account", selection: $model.selectedAccountId) {
                    Text("Any account").tag(String?.none)
                    ForEach(model.accounts, id: \.id) { account in
                        Text(account.name).tag(Optional(account.id))
                    }
                }
                .pickerStyle(.menu)
                .padding(.horizontal)
            }

            if let error = model.errorMessage {
                Text(error)
                    .foregroundColor(.red)
                    .font(.footnote)
                    .padding(.horizontal)
            }

            Button(action: { model.upload() }) {
                if model.isUploading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Upload to Scani")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isUploading || model.imageData == nil)
            .padding(.horizontal)
        }
        .navigationTitle("Scani")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { model.cancel() }
            }
        }
        .onAppear { model.loadAccounts() }
    }
}
