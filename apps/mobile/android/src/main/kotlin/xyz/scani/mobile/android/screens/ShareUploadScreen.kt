package xyz.scani.mobile.android.screens

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareUploadScreen(imageUri: Uri, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val accounts by ServiceLocator.accountsRepository.accounts().collectAsState(initial = emptyList())

    val fileName = imageUri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "screenshot.png"
    val contentType = ctx.contentResolver.getType(imageUri) ?: "image/png"

    var accountExpanded by remember { mutableStateOf(false) }
    var selectedAccountId by remember { mutableStateOf<String?>(null) }
    var selectedAccountName by remember { mutableStateOf("Auto-detect") }
    var status by remember { mutableStateOf<String?>(null) }
    var uploading by remember { mutableStateOf(false) }
    var uploaded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
    ) {
        Text("Upload screenshot", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(fileName, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("Screenshot ready to upload", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(16.dp))

        ExposedDropdownMenuBox(
            expanded = accountExpanded,
            onExpandedChange = { if (!uploading) accountExpanded = it },
            modifier = Modifier.fillMaxWidth(),
        ) {
            OutlinedTextField(
                value = selectedAccountName,
                onValueChange = {},
                readOnly = true,
                label = { Text("Account") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = accountExpanded) },
                modifier = Modifier
                    .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                    .fillMaxWidth(),
            )
            ExposedDropdownMenu(
                expanded = accountExpanded,
                onDismissRequest = { accountExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text("Auto-detect") },
                    onClick = {
                        selectedAccountId = null
                        selectedAccountName = "Auto-detect"
                        accountExpanded = false
                    },
                )
                accounts.forEach { account ->
                    DropdownMenuItem(
                        text = { Text(account.name) },
                        onClick = {
                            selectedAccountId = account.id
                            selectedAccountName = account.name
                            accountExpanded = false
                        },
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        if (!uploaded) {
            Button(
                onClick = {
                    uploading = true
                    status = null
                    scope.launch {
                        try {
                            val bytes = ctx.contentResolver.openInputStream(imageUri)?.readBytes()
                                ?: throw IllegalStateException("Cannot read image")
                            ServiceLocator.screenshotUploadService.upload(bytes, fileName, contentType, selectedAccountId)
                            status = "Uploaded ✓ — Scani is parsing it"
                            uploaded = true
                        } catch (e: Throwable) {
                            status = e.message ?: "Upload failed"
                        } finally {
                            uploading = false
                        }
                    }
                },
                enabled = !uploading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (uploading) "Uploading…" else "Upload")
            }
        } else {
            OutlinedButton(
                onClick = onDone,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Done")
            }
        }

        status?.let { msg ->
            Spacer(Modifier.height(8.dp))
            Text(
                msg,
                color = if (msg.startsWith("Uploaded")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
