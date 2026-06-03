package xyz.scani.mobile.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator

private val COLOR_RE = Regex("^#[0-9A-Fa-f]{6}$")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddScreen() {
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf("group") }
    var status by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        val modes = listOf("group", "vault", "holding")
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            modes.forEachIndexed { idx, m ->
                SegmentedButton(
                    selected = mode == m,
                    onClick = { mode = m; status = null },
                    shape = SegmentedButtonDefaults.itemShape(index = idx, count = modes.size),
                    label = { Text(m.replaceFirstChar(Char::uppercase)) },
                )
            }
        }

        Spacer(Modifier.height(16.dp))

        when (mode) {
            "group" -> GroupForm(scope) { status = it }
            "vault" -> VaultForm(scope) { status = it }
            "holding" -> HoldingForm(scope) { status = it }
        }

        status?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = if (it.startsWith("Saved")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun GroupForm(scope: kotlinx.coroutines.CoroutineScope, onStatus: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var color by remember { mutableStateOf("#3B82F6") }
    var description by remember { mutableStateOf("") }
    val enabled = name.isNotBlank() && COLOR_RE.matches(color)

    OutlinedTextField(
        value = name,
        onValueChange = { name = it },
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = color,
        onValueChange = { color = it },
        label = { Text("Color (hex)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = description,
        onValueChange = { description = it },
        label = { Text("Description (optional)") },
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(16.dp))
    Button(
        onClick = {
            scope.launch {
                try {
                    ServiceLocator.writeQueue.createGroup(name.trim(), color.trim(), description.ifBlank { null })
                    runCatching { ServiceLocator.outboxProcessor.drain() }
                    onStatus("Saved ✓")
                    name = ""
                    description = ""
                } catch (e: Throwable) {
                    onStatus(e.message ?: "Failed")
                }
            }
        },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("Create group")
    }
}

@Composable
private fun VaultForm(scope: kotlinx.coroutines.CoroutineScope, onStatus: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var targetAmount by remember { mutableStateOf("") }
    var currencyId by remember { mutableStateOf("") }
    var color by remember { mutableStateOf("#3B82F6") }
    var iconName by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    val enabled = name.isNotBlank() && targetAmount.isNotBlank() && currencyId.isNotBlank() && COLOR_RE.matches(color)

    OutlinedTextField(
        value = name,
        onValueChange = { name = it },
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = targetAmount,
        onValueChange = { targetAmount = it },
        label = { Text("Target amount") },
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = currencyId,
        onValueChange = { currencyId = it },
        label = { Text("Currency ID (e.g. USD)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = color,
        onValueChange = { color = it },
        label = { Text("Color (hex)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = iconName,
        onValueChange = { iconName = it },
        label = { Text("Icon name (optional)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = description,
        onValueChange = { description = it },
        label = { Text("Description (optional)") },
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(16.dp))
    Button(
        onClick = {
            scope.launch {
                try {
                    ServiceLocator.writeQueue.createVault(
                        name.trim(),
                        targetAmount.trim(),
                        currencyId.trim(),
                        color.trim(),
                        iconName.ifBlank { null },
                        description.ifBlank { null },
                    )
                    runCatching { ServiceLocator.outboxProcessor.drain() }
                    onStatus("Saved ✓")
                    name = ""
                    targetAmount = ""
                    currencyId = ""
                    iconName = ""
                    description = ""
                } catch (e: Throwable) {
                    onStatus(e.message ?: "Failed")
                }
            }
        },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("Create vault")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HoldingForm(scope: kotlinx.coroutines.CoroutineScope, onStatus: (String) -> Unit) {
    val accounts by ServiceLocator.accountsRepository.accounts().collectAsState(initial = emptyList())
    var selectedAccountId by remember { mutableStateOf("") }
    var selectedAccountName by remember { mutableStateOf("") }
    var accountExpanded by remember { mutableStateOf(false) }
    var tokenId by remember { mutableStateOf("") }
    var symbol by remember { mutableStateOf("") }
    var holdingName by remember { mutableStateOf("") }
    var balance by remember { mutableStateOf("") }
    val enabled = selectedAccountId.isNotBlank() && tokenId.isNotBlank() && symbol.isNotBlank() && balance.isNotBlank()

    ExposedDropdownMenuBox(
        expanded = accountExpanded,
        onExpandedChange = { accountExpanded = it },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = selectedAccountName.ifBlank { "Select account" },
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
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = tokenId,
        onValueChange = { tokenId = it },
        label = { Text("Token ID") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = symbol,
        onValueChange = { symbol = it },
        label = { Text("Symbol") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = holdingName,
        onValueChange = { holdingName = it },
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = balance,
        onValueChange = { balance = it },
        label = { Text("Balance") },
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        singleLine = true,
    )
    Spacer(Modifier.height(16.dp))
    Button(
        onClick = {
            scope.launch {
                try {
                    ServiceLocator.writeQueue.createHolding(
                        selectedAccountId,
                        tokenId.trim(),
                        symbol.trim(),
                        holdingName.trim(),
                        balance.trim(),
                    )
                    runCatching { ServiceLocator.outboxProcessor.drain() }
                    onStatus("Saved ✓")
                    selectedAccountId = ""
                    selectedAccountName = ""
                    tokenId = ""
                    symbol = ""
                    holdingName = ""
                    balance = ""
                } catch (e: Throwable) {
                    onStatus(e.message ?: "Failed")
                }
            }
        },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("Create holding")
    }
}
