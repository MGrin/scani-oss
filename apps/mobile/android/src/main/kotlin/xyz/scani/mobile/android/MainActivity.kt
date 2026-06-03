package xyz.scani.mobile.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import xyz.scani.mobile.shared.navigation.DeepLinks
import xyz.scani.mobile.android.auth.AuthUiState
import xyz.scani.mobile.android.auth.AuthViewModel
import xyz.scani.mobile.android.auth.BiometricGate
import xyz.scani.mobile.android.auth.SignInScreen
import xyz.scani.mobile.android.screens.ShareUploadScreen
import xyz.scani.mobile.android.shell.MainShell

class MainActivity : FragmentActivity() {
    private var sharedImageUri by mutableStateOf<Uri?>(null)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureDeepLink(intent)
        sharedImageUri = extractSharedImageUri(intent)
    }

    private fun captureDeepLink(intent: Intent?) {
        intent?.data?.toString()?.let { ServiceLocator.pendingDeepLink = DeepLinks.parse(it) }
    }

    private fun extractSharedImageUri(intent: Intent?): Uri? {
        if (intent?.action != Intent.ACTION_SEND) return null
        if (intent.type?.startsWith("image/") != true) return null
        return if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ServiceLocator.init(this)
        captureDeepLink(intent)
        sharedImageUri = extractSharedImageUri(intent)
        setContent {
            MaterialTheme {
                Surface {
                    val vm: AuthViewModel = viewModel { AuthViewModel(ServiceLocator.authRepository) }
                    val state by vm.state.collectAsState()
                    val uri = sharedImageUri
                    if (state is AuthUiState.Authenticated) {
                        BiometricGate {
                            if (uri != null) {
                                ShareUploadScreen(imageUri = uri, onDone = { sharedImageUri = null })
                            } else {
                                MainShell()
                            }
                        }
                    } else {
                        SignInScreen(vm)
                    }
                }
            }
        }
    }
}
