package xyz.scani.mobile.android

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import xyz.scani.mobile.android.auth.AuthUiState
import xyz.scani.mobile.android.auth.AuthViewModel
import xyz.scani.mobile.android.auth.BiometricGate
import xyz.scani.mobile.android.auth.SignInScreen
import xyz.scani.mobile.android.shell.MainShell

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ServiceLocator.init(this)
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
