package xyz.scani.mobile.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import xyz.scani.mobile.android.ServiceLocator
import xyz.scani.mobile.shared.data.MobileToken
import xyz.scani.mobile.shared.data.MobileTokenResult

private val PRESET_COLORS = listOf(
    "#3B82F6", "#22C55E", "#EF4444", "#F59E0B",
    "#8B5CF6", "#EC4899", "#14B8A6", "#64748B",
)

@Composable
fun ColorPickerRow(selected: String, onPick: (String) -> Unit) {
    Row(modifier = Modifier.horizontalScroll(rememberScrollState())) {
        PRESET_COLORS.forEach { hex ->
            val color = runCatching { Color(android.graphics.Color.parseColor(hex)) }
                .getOrElse { Color.Gray }
            val isSelected = hex.equals(selected, ignoreCase = true)
            Box(
                modifier = Modifier
                    .padding(end = 8.dp)
                    .size(32.dp)
                    .background(color, shape = RoundedCornerShape(percent = 50))
                    .then(
                        if (isSelected) Modifier.border(
                            2.dp,
                            MaterialTheme.colorScheme.onSurface,
                            RoundedCornerShape(percent = 50),
                        ) else Modifier
                    )
                    .clickable { onPick(hex) },
            )
        }
    }
}

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
    val enabled = name.isNotBlank()

    OutlinedTextField(
        value = name,
        onValueChange = { name = it },
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    Text("Color", style = MaterialTheme.typography.labelMedium)
    Spacer(Modifier.height(4.dp))
    ColorPickerRow(selected = color, onPick = { color = it })
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultForm(scope: kotlinx.coroutines.CoroutineScope, onStatus: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var targetAmount by remember { mutableStateOf("") }
    var selectedCurrencyId by remember { mutableStateOf("") }
    var selectedCurrencyLabel by remember { mutableStateOf("") }
    var currencyExpanded by remember { mutableStateOf(false) }
    var currencies by remember { mutableStateOf<List<MobileToken>>(emptyList()) }
    var color by remember { mutableStateOf("#3B82F6") }
    var iconName by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    val enabled = name.isNotBlank() && targetAmount.isNotBlank() && selectedCurrencyId.isNotBlank()

    LaunchedEffect(Unit) {
        currencies = runCatching { ServiceLocator.mobileApi.currencies() }.getOrDefault(emptyList())
    }

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
    ExposedDropdownMenuBox(
        expanded = currencyExpanded,
        onExpandedChange = { currencyExpanded = it },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = selectedCurrencyLabel.ifBlank { "Select currency" },
            onValueChange = {},
            readOnly = true,
            label = { Text("Currency") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = currencyExpanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(
            expanded = currencyExpanded,
            onDismissRequest = { currencyExpanded = false },
        ) {
            currencies.forEach { token ->
                DropdownMenuItem(
                    text = { Text("${token.symbol} — ${token.name}") },
                    onClick = {
                        selectedCurrencyId = token.id
                        selectedCurrencyLabel = "${token.symbol} — ${token.name}"
                        currencyExpanded = false
                    },
                )
            }
        }
    }
    Spacer(Modifier.height(8.dp))
    Text("Color", style = MaterialTheme.typography.labelMedium)
    Spacer(Modifier.height(4.dp))
    ColorPickerRow(selected = color, onPick = { color = it })
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
                        selectedCurrencyId.trim(),
                        color.trim(),
                        iconName.ifBlank { null },
                        description.ifBlank { null },
                    )
                    runCatching { ServiceLocator.outboxProcessor.drain() }
                    onStatus("Saved ✓")
                    name = ""
                    targetAmount = ""
                    selectedCurrencyId = ""
                    selectedCurrencyLabel = ""
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
    var query by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<MobileTokenResult>>(emptyList()) }
    var selectedTokenId by remember { mutableStateOf("") }
    var selectedSymbol by remember { mutableStateOf("") }
    var selectedName by remember { mutableStateOf("") }
    var balance by remember { mutableStateOf("") }
    val enabled = selectedAccountId.isNotBlank() && selectedTokenId.isNotBlank() && balance.isNotBlank()

    LaunchedEffect(query) {
        if (query.length >= 2) {
            delay(300)
            searchResults = runCatching { ServiceLocator.mobileApi.searchTokens(query) }.getOrDefault(emptyList())
        } else {
            searchResults = emptyList()
        }
    }

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
        value = query,
        onValueChange = { query = it; selectedTokenId = ""; selectedSymbol = ""; selectedName = "" },
        label = { Text("Search token") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    if (selectedTokenId.isNotBlank()) {
        Spacer(Modifier.height(4.dp))
        Text(
            "Selected: $selectedSymbol — $selectedName",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
    if (searchResults.isNotEmpty() && selectedTokenId.isBlank()) {
        Spacer(Modifier.height(4.dp))
        LazyColumn(modifier = Modifier.fillMaxWidth().height(160.dp)) {
            items(searchResults, key = { it.id ?: "${it.provider}:${it.symbol}" }) { sel ->
                val label = if (sel.id == null && sel.provider != null)
                    "${sel.symbol} — ${sel.name} (via ${sel.provider})"
                else
                    "${sel.symbol} — ${sel.name}"
                Card(
                    onClick = {
                        scope.launch {
                            try {
                                val tokenId = sel.id ?: ServiceLocator.mobileApi.materializeToken(
                                    sel.symbol,
                                    sel.provider!!,
                                    sel.metadata!!,
                                ).id
                                selectedTokenId = tokenId
                                selectedSymbol = sel.symbol
                                selectedName = sel.name
                                query = "${sel.symbol} — ${sel.name}"
                                searchResults = emptyList()
                            } catch (e: Throwable) {
                                onStatus(e.message ?: "Failed to resolve token")
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                ) {
                    Text(
                        label,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
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
                        selectedTokenId,
                        selectedSymbol,
                        selectedName,
                        balance.trim(),
                    )
                    runCatching { ServiceLocator.outboxProcessor.drain() }
                    onStatus("Saved ✓")
                    selectedAccountId = ""
                    selectedAccountName = ""
                    query = ""
                    selectedTokenId = ""
                    selectedSymbol = ""
                    selectedName = ""
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
