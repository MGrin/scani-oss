package xyz.scani.mobile.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import xyz.scani.mobile.shared.navigation.DeepLinks
import xyz.scani.mobile.android.auth.AuthUiState
import xyz.scani.mobile.android.auth.AuthViewModel
import xyz.scani.mobile.android.auth.BiometricGate
import xyz.scani.mobile.android.auth.SignInScreen
import xyz.scani.mobile.android.shell.MainShell

class MainActivity : FragmentActivity() {
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureDeepLink(intent)
    }

    // Parses an incoming App-Link into a typed Destination for the shell to
    // consume. MainShell will route ServiceLocator.pendingDeepLink to the nav
    // controller once the destination screens land in Milestone 3.
    private fun captureDeepLink(intent: Intent?) {
        intent?.data?.toString()?.let { ServiceLocator.pendingDeepLink = DeepLinks.parse(it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ServiceLocator.init(this)
        captureDeepLink(intent)
        setContent {
            MaterialTheme {
                Surface {
                    val vm: AuthViewModel = viewModel { AuthViewModel(ServiceLocator.authRepository) }
                    val state by vm.state.collectAsState()
                    if (state is AuthUiState.Authenticated) {
                        BiometricGate { MainShell() }
                    } else {
                        SignInScreen(vm)
                    }
                }
            }
        }
    }
}
