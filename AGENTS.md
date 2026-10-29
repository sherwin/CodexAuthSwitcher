# 仓库工作规则

- 每次完成代码修改后，先运行与修改相关的测试和必要检查；通过后直接创建 Git 提交，并推送到当前分支配置的远程上游，无需再次询问。
- 每次提交只包含当前任务的修改，不得擅自提交用户的其他未提交改动、授权文件、Token、API Key 或其他敏感数据。
- 禁止强制推送、覆盖远程历史或为提交而跳过失败的检查。测试、提交或推送失败时，保留现场并明确报告原因，不得声称已提交到远程。

## Localization and open-source neutrality

- English is the default UI language. Any user-visible text added to HTML, renderer code, dialogs, errors, accessibility labels, logs shown in the UI, or web bridge code must use the shared `electron/i18n.js` resources and have both English and Simplified Chinese text.
- Keep the language switcher working in both the desktop window and authenticated web UI. Do not hard-code a single locale in new features; preserve the saved language preference.
- Do not add maintainer names, private machine names, personal paths, credentials, tokens, or machine-specific host labels to product text, defaults, tests, or documentation. Use generic terms such as Linux host, local machine, or configured auth directory.
- Do not modify authorization JSON, proxy account data, or runtime state as part of localization work.
