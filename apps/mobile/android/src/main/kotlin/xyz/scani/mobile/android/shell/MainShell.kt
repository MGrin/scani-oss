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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController

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
            for (tab in Tab.entries) {
                composable(tab.route) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(tab.label) }
                }
            }
        }
    }
}
