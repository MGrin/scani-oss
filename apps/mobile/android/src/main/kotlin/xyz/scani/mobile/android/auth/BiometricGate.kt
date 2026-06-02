package xyz.scani.mobile.android.auth

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

private const val AUTHENTICATORS =
    BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL

@Composable
fun BiometricGate(content: @Composable () -> Unit) {
    val activity = LocalContext.current as? FragmentActivity
    var unlocked by remember { mutableStateOf(false) }

    if (unlocked || activity == null) {
        content()
        return
    }

    val available = BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS) ==
        BiometricManager.BIOMETRIC_SUCCESS
    if (!available) {
        // No biometric/credential enrolled — don't lock the user out.
        content()
        return
    }

    fun prompt() {
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    unlocked = true
                }
                // onAuthenticationError fires on cancel/timeout/too-many-attempts; we
                // leave `unlocked=false` so the retry button below remains the way
                // forward instead of a dead blank screen.
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock Scani")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build(),
        )
    }

    // Auto-launch once when the gate first appears.
    LaunchedEffect(Unit) { prompt() }

    // Fallback UI so a dismissed/errored prompt is never a dead end.
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Scani is locked")
        Button(onClick = { prompt() }) { Text("Unlock") }
    }
}
