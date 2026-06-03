package xyz.scani.mobile.android.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

@Composable
fun SignInScreen(vm: AuthViewModel) {
    val state by vm.state.collectAsState()
    val busy by vm.busy.collectAsState()
    var email by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Sign in to Scani")
        when (val s = state) {
            is AuthUiState.EnterEmail, is AuthUiState.Error -> {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                )
                Button(onClick = { vm.sendCode(email.trim()) }, enabled = !busy && email.isNotBlank()) {
                    Text("Send code")
                }
                if (s is AuthUiState.Error) Text(s.message)
            }
            is AuthUiState.EnterCode -> {
                Text("Enter the 6-digit code sent to ${s.email}")
                OutlinedTextField(
                    value = code,
                    onValueChange = { if (it.length <= 6) code = it.filter(Char::isDigit) },
                    label = { Text("Code") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Button(onClick = { vm.verify(s.email, code) }, enabled = !busy && code.length == 6) {
                    Text("Verify")
                }
            }
            AuthUiState.Authenticated -> Text("Signed in")
        }
        if (busy) CircularProgressIndicator()
    }
}
