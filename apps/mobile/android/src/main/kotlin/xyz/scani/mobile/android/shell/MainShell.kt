package xyz.scani.mobile.android.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator
import xyz.scani.mobile.shared.navigation.Destination
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import xyz.scani.mobile.android.screens.AccountsScreen
import xyz.scani.mobile.android.screens.DashboardScreen
import xyz.scani.mobile.android.screens.HoldingsScreen

private enum class Tab(val route: String, val label: String, val icon: ImageVector) {
    Dashboard("dashboard", "Dashboard", Icons.Filled.Dashboard),
    Holdings("holdings", "Holdings", Icons.AutoMirrored.Filled.List),
    Accounts("accounts", "Accounts", Icons.Filled.AccountBalance),
    Add("add", "Add", Icons.Filled.Add),
    Settings("settings", "Settings", Icons.Filled.Settings),
}

@Composable
fun MainShell() {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                scope.launch {
                    runCatching { ServiceLocator.syncEngine.syncAccounts() }
                    runCatching { ServiceLocator.syncEngine.syncHoldings() }
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }
    // Detail-destination routing (Holding/Vault/Group/Job) is deferred to a later milestone.
    LaunchedEffect(Unit) {
        val dest = ServiceLocator.pendingDeepLink
        ServiceLocator.pendingDeepLink = null
        val route = when (dest) {
            is Destination.Holding -> Tab.Holdings.route
            is Destination.Account, is Destination.Institution -> Tab.Accounts.route
            else -> null
        }
        if (route != null) {
            nav.navigate(route) { launchSingleTop = true }
        }
        launch { runCatching { ServiceLocator.syncEngine.syncAccounts() } }
        launch { runCatching { ServiceLocator.syncEngine.syncHoldings() } }
    }
    Scaffold(
        bottomBar = {
            val current by nav.currentBackStackEntryAsState()
            NavigationBar {
                for (tab in Tab.entries) {
                    NavigationBarItem(
                        selected = current?.destination?.route == tab.route,
                        onClick = {
                            nav.navigate(tab.route) {
                                popUpTo(Tab.Dashboard.route) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(nav, startDestination = Tab.Dashboard.route, modifier = Modifier.padding(padding)) {
            composable(Tab.Dashboard.route) { DashboardScreen() }
            composable(Tab.Holdings.route) { HoldingsScreen() }
            composable(Tab.Accounts.route) { AccountsScreen() }
            composable(Tab.Add.route) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(Tab.Add.label) }
            }
            composable(Tab.Settings.route) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(Tab.Settings.label) }
            }
        }
    }
}
