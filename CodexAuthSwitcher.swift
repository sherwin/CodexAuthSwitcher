import AppKit
import CryptoKit
import SwiftUI

private let authDirectoryURL = URL(fileURLWithPath: "/Users/sherwin/Code/Codex-auth", isDirectory: true)
private let activeAuthURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".codex/auth.json", isDirectory: false)

struct AuthFile: Identifiable, Equatable {
    let url: URL
    let modifiedAt: Date

    var id: URL { url }
    var name: String { url.lastPathComponent }
}

private struct AuthCredentials {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let accountID: String?
    let clientID: String?
    let expiresAt: Date?
}

private struct OAuthTokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case idToken = "id_token"
    }
}

private struct ServiceError: LocalizedError {
    let statusCode: Int?
    let code: String?
    let message: String

    var errorDescription: String? {
        if let code, !code.isEmpty {
            return "\(message) (\(code))"
        }
        return message
    }
}

private struct UsageAPIResponse: Decodable {
    struct Window: Decodable {
        let usedPercent: Double?
        let resetsAt: TimeInterval?

        enum CodingKeys: String, CodingKey {
            case usedPercent, used_percent, resetsAt, reset_at
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            usedPercent = try container.decodeIfPresent(Double.self, forKey: .usedPercent)
                ?? container.decodeIfPresent(Double.self, forKey: .used_percent)
            resetsAt = try container.decodeIfPresent(TimeInterval.self, forKey: .resetsAt)
                ?? container.decodeIfPresent(TimeInterval.self, forKey: .reset_at)
        }
    }

    struct RateLimit: Decodable {
        let primary: Window?
        let secondary: Window?
        let planType: String?

        enum CodingKeys: String, CodingKey {
            case primary, secondary, primary_window, secondary_window, planType, plan_type
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            primary = try container.decodeIfPresent(Window.self, forKey: .primary)
                ?? container.decodeIfPresent(Window.self, forKey: .primary_window)
            secondary = try container.decodeIfPresent(Window.self, forKey: .secondary)
                ?? container.decodeIfPresent(Window.self, forKey: .secondary_window)
            planType = try container.decodeIfPresent(String.self, forKey: .planType)
                ?? container.decodeIfPresent(String.self, forKey: .plan_type)
        }
    }

    struct ResetCredits: Decodable {
        struct Credit: Decodable {
            let expiresAt: TimeInterval?
            let status: String?

            enum CodingKeys: String, CodingKey { case expiresAt, expires_at, status }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                if let timestamp = try container.decodeIfPresent(TimeInterval.self, forKey: .expiresAt)
                    ?? container.decodeIfPresent(TimeInterval.self, forKey: .expires_at) {
                    expiresAt = timestamp
                } else if let dateString = try container.decodeIfPresent(String.self, forKey: .expires_at) {
                    expiresAt = ISO8601DateFormatter().date(from: dateString)?.timeIntervalSince1970
                } else {
                    expiresAt = nil
                }
                status = try container.decodeIfPresent(String.self, forKey: .status)
            }
        }

        let availableCount: Int?
        let credits: [Credit]?

        enum CodingKeys: String, CodingKey {
            case availableCount, available_count, credits
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            availableCount = try container.decodeIfPresent(Int.self, forKey: .availableCount)
                ?? container.decodeIfPresent(Int.self, forKey: .available_count)
            credits = try container.decodeIfPresent([Credit].self, forKey: .credits)
        }
    }

    let rateLimits: RateLimit?
    let rateLimitsByLimitId: [String: RateLimit]?
    let rateLimitResetCredits: ResetCredits?
    let rateLimit: RateLimit?
    let planType: String?

    enum CodingKeys: String, CodingKey {
        case rateLimits, rateLimitsByLimitId, rateLimitResetCredits
        case rate_limit, rate_limit_reset_credits, plan_type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rateLimits = try container.decodeIfPresent(RateLimit.self, forKey: .rateLimits)
        rateLimitsByLimitId = try container.decodeIfPresent([String: RateLimit].self, forKey: .rateLimitsByLimitId)
        rateLimitResetCredits = try container.decodeIfPresent(ResetCredits.self, forKey: .rateLimitResetCredits)
            ?? container.decodeIfPresent(ResetCredits.self, forKey: .rate_limit_reset_credits)
        rateLimit = try container.decodeIfPresent(RateLimit.self, forKey: .rate_limit)
        planType = try container.decodeIfPresent(String.self, forKey: .plan_type)
    }
}

struct UsageSnapshot: Codable {
    struct Window: Codable {
        let usedPercent: Double
        let resetsAt: Date?
    }

    let fiveHour: Window?
    let weekly: Window?
    let resetCreditCount: Int
    let resetCreditExpiry: Date?
    let planType: String?
    let subscriptionExpiry: Date?
    let fetchedAt: Date
}

private struct UsageCache: Codable {
    let version: Int
    let authFingerprint: String
    let snapshot: UsageSnapshot
}

private let usageCacheDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Caches/CodexAuthSwitcher", isDirectory: true)
private let usageCacheLifetime: TimeInterval = 5 * 60
private let tokenRefreshLeeway: TimeInterval = 5 * 60
private let usageEndpoint = URL(string: "https://chatgpt.com/backend-api/wham/usage")!
private let accountEndpoint = URL(string: "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27")!
private let tokenEndpoint = URL(string: "https://auth.openai.com/api/accounts/oauth/token")!

@MainActor
final class AuthStore: ObservableObject {
    @Published private(set) var authFiles: [AuthFile] = []
    @Published var selectedID: URL?
    @Published private(set) var activeID: URL?
    @Published private(set) var statusMessage = ""
    @Published private(set) var usageSnapshots: [URL: UsageSnapshot] = [:]
    @Published private(set) var loadingUsageIDs: Set<URL> = []
    @Published private(set) var usageMessages: [URL: String] = [:]
    @Published var showSwitchConfirmation = false
    @Published var errorMessage: String?
    init() {
        refresh()
    }

    var selectedFile: AuthFile? {
        authFiles.first { $0.id == selectedID }
    }

    var selectedIsActive: Bool {
        selectedID != nil && selectedID == activeID
    }

    var selectedUsageSnapshot: UsageSnapshot? {
        guard let selectedID else { return nil }
        return usageSnapshots[selectedID]
    }

    var selectedUsageMessage: String {
        guard let selectedID else { return "Select an account to view usage." }
        return usageMessages[selectedID] ?? "Usage data has not been loaded."
    }

    var selectedUsageIsLoading: Bool {
        guard let selectedID else { return false }
        return loadingUsageIDs.contains(selectedID)
    }

    func refresh() {
        do {
            let fileManager = FileManager.default
            let resourceKeys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey]
            let urls = try fileManager.contentsOfDirectory(
                at: authDirectoryURL,
                includingPropertiesForKeys: Array(resourceKeys),
                options: [.skipsHiddenFiles]
            )

            authFiles = try urls.compactMap { url in
                let values = try url.resourceValues(forKeys: resourceKeys)
                guard values.isRegularFile == true, url.pathExtension.lowercased() == "json" else {
                    return nil
                }
                return AuthFile(url: url, modifiedAt: values.contentModificationDate ?? .distantPast)
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

            activeID = try findActiveFileID()
            if selectedID == nil || !authFiles.contains(where: { $0.id == selectedID }) {
                selectedID = activeID ?? authFiles.first?.id
            }
            statusMessage = activeID == nil ? "No matching active account found." : "Current account is marked Active."
            loadUsageForAllIfNeeded()
        } catch {
            authFiles = []
            activeID = nil
            statusMessage = ""
            errorMessage = "Unable to load authorization files: \(error.localizedDescription)"
        }
    }

    func switchToSelected() {
        guard let selectedFile else { return }

        do {
            _ = try findActiveFileID()
            let sourceData = try Data(contentsOf: selectedFile.url)
            guard !sourceData.isEmpty else {
                throw CocoaError(.fileReadCorruptFile)
            }

            try writeCredentialData(sourceData, to: activeAuthURL)

            activeID = selectedFile.id
            statusMessage = "Switched to \(selectedFile.name). Restart Codex if it is already running."
        } catch {
            errorMessage = "Authorization was not changed: \(error.localizedDescription)"
        }
    }

    private func findActiveFileID() throws -> URL? {
        guard FileManager.default.fileExists(atPath: activeAuthURL.path) else { return nil }
        let activeData = try Data(contentsOf: activeAuthURL)
        if let exactMatch = try authFiles.first(where: { try Data(contentsOf: $0.url) == activeData }) {
            return exactMatch.id
        }

        guard let activeCredentials = credentials(from: activeData),
              let activeAccountID = activeCredentials.accountID,
              let accountMatch = authFiles.first(where: {
                  guard let data = try? Data(contentsOf: $0.url) else { return false }
                  return credentials(from: data)?.accountID == activeAccountID
              }) else {
            return nil
        }

        let backupData = try Data(contentsOf: accountMatch.url)
        let backupExpiry = credentials(from: backupData)?.expiresAt ?? .distantPast
        if (activeCredentials.expiresAt ?? .distantPast) > backupExpiry {
            try writeCredentialData(activeData, to: accountMatch.url)
        }
        return accountMatch.id
    }

    func refreshUsage() {
        loadUsageForAllIfNeeded(force: true)
    }

    private func loadUsageForAllIfNeeded(force: Bool = false) {
        for authFile in authFiles {
            loadUsage(for: authFile, force: force)
        }
    }

    private func loadUsage(for authFile: AuthFile, force: Bool) {
        guard !loadingUsageIDs.contains(authFile.id) else { return }
        guard let authData = try? Data(contentsOf: authFile.url),
              let currentCredentials = credentials(from: authData) else {
            usageSnapshots.removeValue(forKey: authFile.id)
            usageMessages[authFile.id] = "No readable Codex access token in this file."
            return
        }

        let fingerprint = SHA256.hash(data: authData).map { String(format: "%02x", $0) }.joined()
        if !force,
           !credentialsNeedRefresh(currentCredentials),
           let cache = loadCache(for: fingerprint),
           cache.authFingerprint == fingerprint,
           Date().timeIntervalSince(cache.snapshot.fetchedAt) < usageCacheLifetime {
            usageSnapshots[authFile.id] = cache.snapshot
            usageMessages[authFile.id] = "Loaded from cache."
            return
        }

        loadingUsageIDs.insert(authFile.id)
        usageMessages[authFile.id] = "Loading usage data…"
        Task {
            do {
                let (snapshot, refreshed) = try await fetchUsageWithRenewal(for: authFile)
                let latestData = try Data(contentsOf: authFile.url)
                let latestFingerprint = SHA256.hash(data: latestData).map { String(format: "%02x", $0) }.joined()
                usageSnapshots[authFile.id] = snapshot
                usageMessages[authFile.id] = refreshed
                    ? "Authorization renewed and usage updated."
                    : "Updated \(snapshot.fetchedAt.formatted(date: .omitted, time: .shortened))."
                if !saveCache(UsageCache(version: 3, authFingerprint: latestFingerprint, snapshot: snapshot), for: latestFingerprint) {
                    usageMessages[authFile.id] = "Usage loaded, but cache could not be saved."
                }
            } catch {
                NSLog("Usage refresh failed for %@: %@", authFile.name, error.localizedDescription)
                if let cache = loadCache(for: fingerprint), cache.authFingerprint == fingerprint {
                    usageSnapshots[authFile.id] = cache.snapshot
                    usageMessages[authFile.id] = "\(error.localizedDescription) Showing cached data."
                } else {
                    usageSnapshots.removeValue(forKey: authFile.id)
                    usageMessages[authFile.id] = "Unable to load usage data: \(error.localizedDescription)"
                }
            }
            loadingUsageIDs.remove(authFile.id)
        }
    }

    private func fetchUsageWithRenewal(for authFile: AuthFile) async throws -> (UsageSnapshot, Bool) {
        var credentials = try loadCredentials(from: authFile.url)
        var refreshed = false

        if credentialsNeedRefresh(credentials) {
            credentials = try await renewCredentials(credentials, for: authFile)
            refreshed = true
        }

        do {
            let snapshot = try await fetchUsage(
                accessToken: credentials.accessToken,
                accountID: credentials.accountID
            )
            return (snapshot, refreshed)
        } catch let error as ServiceError where error.statusCode == 401 && !refreshed {
            credentials = try await renewCredentials(credentials, for: authFile)
            let snapshot = try await fetchUsage(
                accessToken: credentials.accessToken,
                accountID: credentials.accountID
            )
            return (snapshot, true)
        }
    }

    private func loadCredentials(from url: URL) throws -> AuthCredentials {
        let data = try Data(contentsOf: url)
        guard let credentials = credentials(from: data) else {
            throw ServiceError(statusCode: nil, code: "invalid_credentials", message: "The authorization file is incomplete.")
        }
        return credentials
    }

    private func credentials(from data: Data) -> AuthCredentials? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokens = root["tokens"] as? [String: Any],
              let accessToken = tokens["access_token"] as? String,
              !accessToken.isEmpty else {
            return nil
        }

        let idToken = tokens["id_token"] as? String
        let explicitClientID = root["client_id"] as? String ?? tokens["client_id"] as? String
        return AuthCredentials(
            accessToken: accessToken,
            refreshToken: tokens["refresh_token"] as? String,
            idToken: idToken,
            accountID: tokens["account_id"] as? String,
            clientID: explicitClientID ?? clientID(fromIDToken: idToken),
            expiresAt: tokenExpiry(accessToken)
        )
    }

    private func credentialsNeedRefresh(_ credentials: AuthCredentials) -> Bool {
        guard let expiresAt = credentials.expiresAt else { return true }
        return expiresAt.timeIntervalSinceNow <= tokenRefreshLeeway
    }

    private func renewCredentials(_ credentials: AuthCredentials, for authFile: AuthFile) async throws -> AuthCredentials {
        guard let refreshToken = credentials.refreshToken, !refreshToken.isEmpty else {
            throw ServiceError(statusCode: nil, code: "login_required", message: "No refresh token is available. Sign in again.")
        }
        guard let clientID = credentials.clientID, !clientID.isEmpty else {
            throw ServiceError(statusCode: nil, code: "login_required", message: "The client ID is missing. Sign in again to migrate this account.")
        }

        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "refresh_token", value: refreshToken),
            URLQueryItem(name: "resource", value: "https://api.openai.com/v1")
        ]

        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = components.percentEncodedQuery?.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ServiceError(statusCode: nil, code: nil, message: "The authorization server returned an invalid response.")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw serviceError(statusCode: httpResponse.statusCode, data: data, fallback: "Authorization renewal failed.")
        }

        let replacement: OAuthTokenResponse
        do {
            replacement = try JSONDecoder().decode(OAuthTokenResponse.self, from: data)
        } catch {
            throw ServiceError(statusCode: httpResponse.statusCode, code: "invalid_token_response", message: "The authorization server returned incomplete replacement credentials.")
        }

        let updatedData = try replacingCredentials(
            in: Data(contentsOf: authFile.url),
            replacement: replacement,
            clientID: clientID
        )
        if authFile.id == activeID {
            try writeCredentialData(updatedData, to: activeAuthURL)
        }
        try writeCredentialData(updatedData, to: authFile.url)

        guard let updatedCredentials = self.credentials(from: updatedData) else {
            throw ServiceError(statusCode: nil, code: "invalid_credentials", message: "Renewed credentials could not be read.")
        }
        return updatedCredentials
    }

    private func replacingCredentials(
        in data: Data,
        replacement: OAuthTokenResponse,
        clientID: String
    ) throws -> Data {
        guard var root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              var tokens = root["tokens"] as? [String: Any] else {
            throw ServiceError(statusCode: nil, code: "invalid_credentials", message: "The authorization file cannot be updated.")
        }

        tokens["access_token"] = replacement.accessToken
        if let refreshToken = replacement.refreshToken, !refreshToken.isEmpty {
            tokens["refresh_token"] = refreshToken
        }
        if let idToken = replacement.idToken, !idToken.isEmpty {
            tokens["id_token"] = idToken
        }
        root["tokens"] = tokens
        root["client_id"] = clientID
        root["last_refresh"] = ISO8601DateFormatter().string(from: Date())
        return try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
    }

    private func writeCredentialData(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func tokenExpiry(_ token: String) -> Date? {
        guard let payload = jwtPayload(token), let timestamp = payload["exp"] as? TimeInterval else {
            return nil
        }
        return Date(timeIntervalSince1970: timestamp)
    }

    private func clientID(fromIDToken idToken: String?) -> String? {
        guard let idToken, let payload = jwtPayload(idToken) else { return nil }
        if let audience = payload["aud"] as? String { return audience }
        return (payload["aud"] as? [String])?.first
    }

    private func jwtPayload(_ token: String) -> [String: Any]? {
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count > 1 else { return nil }
        var base64 = String(segments[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func fetchUsage(accessToken: String, accountID: String?) async throws -> UsageSnapshot {
        async let usageData = fetch(endpoint: usageEndpoint, accessToken: accessToken, accountID: accountID)
        async let accountData = fetch(endpoint: accountEndpoint, accessToken: accessToken, accountID: accountID)
        let usageResponse = try JSONDecoder().decode(UsageAPIResponse.self, from: try await usageData)
        let rawAccountData = try? await accountData

        let rateLimit = usageResponse.rateLimit
            ?? usageResponse.rateLimitsByLimitId?["codex"]
            ?? usageResponse.rateLimits
        guard rateLimit?.primary != nil || rateLimit?.secondary != nil else {
            throw CocoaError(.fileReadUnknown)
        }
        let resetCredits = usageResponse.rateLimitResetCredits
        let availableCredits = (resetCredits?.credits ?? []).filter { $0.status == "available" }
        let expiry = availableCredits.compactMap { $0.expiresAt }.min().map(Date.init(timeIntervalSince1970:))

        return UsageSnapshot(
            fiveHour: makeWindow(rateLimit?.primary),
            weekly: makeWindow(rateLimit?.secondary),
            resetCreditCount: resetCredits?.availableCount ?? availableCredits.count,
            resetCreditExpiry: expiry,
            planType: (usageResponse.planType ?? rateLimit?.planType)?.capitalized,
            subscriptionExpiry: rawAccountData.flatMap {
                findSubscriptionExpiry(in: $0, accountID: accountID)
            },
            fetchedAt: Date()
        )
    }

    private func fetch(endpoint: URL, accessToken: String, accountID: String?) async throws -> Data {
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("https://chatgpt.com", forHTTPHeaderField: "Origin")
        request.setValue("https://chatgpt.com/", forHTTPHeaderField: "Referer")
        request.setValue("codex_auth_switcher", forHTTPHeaderField: "originator")
        if let accountID, !accountID.isEmpty {
            request.setValue(accountID, forHTTPHeaderField: "ChatGPT-Account-Id")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ServiceError(statusCode: nil, code: nil, message: "The server returned an invalid response.")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw serviceError(statusCode: httpResponse.statusCode, data: data, fallback: "Unable to load usage data.")
        }
        return data
    }

    private func serviceError(statusCode: Int, data: Data, fallback: String) -> ServiceError {
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = root?["error"] as? [String: Any]
        let detail = root?["detail"] as? [String: Any]
        let code = error?["code"] as? String
            ?? detail?["code"] as? String
            ?? root?["code"] as? String
            ?? root?["error"] as? String
        let message = error?["message"] as? String
            ?? detail?["message"] as? String
            ?? root?["message"] as? String
            ?? root?["error_description"] as? String
            ?? (code == "invalid_grant" ? "The saved session can no longer be renewed. Sign in again." : nil)
            ?? "\(fallback) HTTP \(statusCode)."
        return ServiceError(statusCode: statusCode, code: code, message: message)
    }

    private func makeWindow(_ window: UsageAPIResponse.Window?) -> UsageSnapshot.Window? {
        guard let usedPercent = window?.usedPercent else { return nil }
        return UsageSnapshot.Window(
            usedPercent: usedPercent,
            resetsAt: window?.resetsAt.map(Date.init(timeIntervalSince1970:))
        )
    }

    private func findSubscriptionExpiry(in data: Data, accountID: String?) -> Date? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accounts = root["accounts"] as? [String: Any] else {
            return nil
        }
        let account = accountID.flatMap { accounts[$0] } as? [String: Any]
            ?? accounts["default"] as? [String: Any]
        let entitlement = account?["entitlement"] as? [String: Any]
        return subscriptionDate(from: entitlement?["expires_at"])
            ?? subscriptionDate(from: entitlement?["renews_at"])
            ?? subscriptionDate(from: entitlement?["cancels_at"])
    }

    private func subscriptionDate(from value: Any?) -> Date? {
        if let timestamp = value as? TimeInterval, timestamp > 1_000_000_000 {
            return Date(timeIntervalSince1970: timestamp)
        }
        if let dateString = value as? String {
            return ISO8601DateFormatter().date(from: dateString)
        }
        return nil
    }

    private func cacheURL(for fingerprint: String) -> URL {
        usageCacheDirectoryURL.appendingPathComponent("usage-\(fingerprint).json", isDirectory: false)
    }

    private func loadCache(for fingerprint: String) -> UsageCache? {
        guard let data = try? Data(contentsOf: cacheURL(for: fingerprint)) else { return nil }
        guard let cache = try? JSONDecoder().decode(UsageCache.self, from: data), cache.version == 3 else {
            return nil
        }
        return cache
    }

    private func saveCache(_ cache: UsageCache, for fingerprint: String) -> Bool {
        do {
            try FileManager.default.createDirectory(at: usageCacheDirectoryURL, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(cache)
            try data.write(to: cacheURL(for: fingerprint), options: .atomic)
            return true
        } catch {
            return false
        }
    }
}

struct ContentView: View {
    @StateObject private var store = AuthStore()

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Codex Auth Switcher")
                        .font(.title2.weight(.semibold))
                    Text("Select a backup from /Users/sherwin/Code/Codex-auth")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh Accounts", action: store.refresh)
            }
            .padding(20)

            HStack {
                Text("Each account is cached separately for 5 minutes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Refresh All Usage", action: store.refreshUsage)
                    .disabled(!store.loadingUsageIDs.isEmpty)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 10)

            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(store.authFiles) { authFile in
                        Button {
                            store.selectedID = authFile.id
                        } label: {
                            accountCard(for: authFile)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            }
            .overlay {
                if store.authFiles.isEmpty {
                    ContentUnavailableView("No authorization backups", systemImage: "key.slash", description: Text("Add .json files to /Users/sherwin/Code/Codex-auth, then refresh."))
                }
            }

            Divider()

            HStack {
                Text(store.statusMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Switch to Selected") {
                    store.showSwitchConfirmation = true
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.selectedFile == nil || store.selectedIsActive)
            }
            .padding(16)
        }
        .frame(minWidth: 760, minHeight: 560)
        .alert("Switch Codex account?", isPresented: $store.showSwitchConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Switch", role: .destructive) {
                store.switchToSelected()
            }
        } message: {
            Text("This replaces ~/.codex/auth.json with the contents of \(store.selectedFile?.name ?? "the selected file").")
        }
        .alert("Operation failed", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.errorMessage ?? "Unknown error")
        }
    }

    private func accountCard(for authFile: AuthFile) -> some View {
        let usage = store.usageSnapshots[authFile.id]
        let isActive = authFile.id == store.activeID
        let isSelected = authFile.id == store.selectedID
        let isLoading = store.loadingUsageIDs.contains(authFile.id)

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Image(systemName: isActive ? "checkmark.circle.fill" : "person.crop.circle")
                    .font(.title2)
                    .foregroundStyle(isActive ? .green : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(authFile.name)
                        .font(.headline)
                    Text("Updated \(authFile.modifiedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let planType = usage?.planType {
                    Text(planType)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(.blue.opacity(0.12), in: Capsule())
                }
                if isActive {
                    Text("ACTIVE")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.green)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(.green.opacity(0.12), in: Capsule())
                }
            }

            HStack(spacing: 10) {
                usageMetric(
                    title: "5-HOUR",
                    value: usage?.fiveHour.map { "\(remainingPercent(from: $0.usedPercent))% remaining" } ?? "—",
                    detail: resetText(for: usage?.fiveHour),
                    valueColor: remainingColor(for: usage?.fiveHour?.usedPercent),
                    detailColor: resetColor(for: usage?.fiveHour?.resetsAt)
                )
                usageMetric(
                    title: "WEEKLY",
                    value: usage?.weekly.map { "\(remainingPercent(from: $0.usedPercent))% remaining" } ?? "—",
                    detail: resetText(for: usage?.weekly),
                    valueColor: remainingColor(for: usage?.weekly?.usedPercent),
                    detailColor: resetColor(for: usage?.weekly?.resetsAt)
                )
                usageMetric(
                    title: "RESET CARDS",
                    value: usage.map { "\($0.resetCreditCount) available" } ?? "—",
                    detail: usage?.resetCreditExpiry.map { "Expires \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Expiry unavailable",
                    detailColor: expiryColor(for: usage?.resetCreditExpiry)
                )
                usageMetric(
                    title: "MEMBERSHIP",
                    value: usage?.subscriptionExpiry.map { $0.formatted(date: .abbreviated, time: .omitted) } ?? "—",
                    detail: usage?.subscriptionExpiry == nil ? "Expiry unavailable" : "Expires on",
                    valueColor: expiryColor(for: usage?.subscriptionExpiry)
                )
            }

            HStack {
                if isLoading {
                    ProgressView().controlSize(.small)
                    Text("Loading usage…")
                } else {
                    Text(store.usageMessages[authFile.id] ?? "Usage data has not been loaded.")
                }
                Spacer()
                if isSelected && !isActive {
                    Text("Selected for switching")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.blue)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(isSelected ? Color.accentColor.opacity(0.08) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(isSelected ? Color.accentColor.opacity(0.7) : Color(nsColor: .separatorColor).opacity(0.35), lineWidth: isSelected ? 2 : 1)
        }
    }

    private func resetText(for window: UsageSnapshot.Window?) -> String {
        window?.resetsAt.map { "Resets \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Reset unavailable"
    }

    private func remainingPercent(from usedPercent: Double) -> Int {
        Int(min(max(100 - usedPercent, 0), 100).rounded())
    }

    private func remainingColor(for usedPercent: Double?) -> Color {
        guard let usedPercent else { return .secondary }
        switch remainingPercent(from: usedPercent) {
        case ...20:
            return .red
        case ...50:
            return .orange
        default:
            return .green
        }
    }

    private func expiryColor(for expiryDate: Date?) -> Color {
        guard let expiryDate else { return .secondary }
        let daysRemaining = expiryDate.timeIntervalSinceNow / (24 * 60 * 60)
        switch daysRemaining {
        case ..<7:
            return .red
        case ..<30:
            return .orange
        default:
            return .green
        }
    }

    private func resetColor(for resetDate: Date?) -> Color {
        guard let resetDate else { return .secondary }
        let hoursRemaining = resetDate.timeIntervalSinceNow / (60 * 60)
        switch hoursRemaining {
        case ...0:
            return .secondary
        case ...24:
            return .green
        case ...(7 * 24):
            return .orange
        default:
            return .red
        }
    }

    private func usageMetric(
        title: String,
        value: String,
        detail: String,
        valueColor: Color = .primary,
        detailColor: Color = .secondary
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(valueColor)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(detailColor)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
    }
}

@main
struct CodexAuthSwitcherApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowResizability(.contentMinSize)
    }
}
