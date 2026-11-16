# 练日 · FitCalendar

练日是一款 Android 健身日历，用于记录训练、重量、组数和饮食。动作教学视频可离线播放。本仓库提供安装包、更新日志和应用内更新清单。

## 安装与更新

1. 打开本平台的**发行版**页面，从测试版的附件下载 `fitcalendar-beta-...apk`。APK 支持 Android 8.0 及以上。
2. 已安装同签名的练日测试版时，打开 APK 覆盖安装，即可保留训练和饮食记录。
3. 从 2.5.1 起，在 **设置 → 应用更新 → 测试版** 检查更新。选「自动选择」可检查三个来源，也可手动选择本平台。

## 下载入口

- [Gitee 发行版](https://gitee.com/altalatic/fitcalendar-releases/releases)
- [GitHub Releases](https://github.com/altale0218/fitcalendar-releases/releases)
- [Cloudflare 测试版清单](https://fitcalendar-updates.pages.dev/beta.json)

## 更新清单

`update/beta.json` 记录当前测试版的版本、更新日志、下载地址、文件大小和 SHA-256。稳定版使用独立的 `update/stable.json`，首个稳定版发布后可用。

GitHub 发行版由仓库的 [镜像工作流](https://github.com/altale0218/fitcalendar-releases/actions/workflows/mirror-ota.yml) 生成，上传前会校验 APK 的大小和 SHA-256。
