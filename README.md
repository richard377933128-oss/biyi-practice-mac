# 笔译训练

轻量独立软件：只保留意群中译英及相关配套，原 PTE终结者 工程未改动。

## iPhone

已可装机。工程在 `biyi-practice/mobile`：

- 显示名：**笔译训练**
- Bundle ID：`com.jinbaoli.biyixunlian`

```bash
cd biyi-practice/mobile
npm run sync   # 同步网页并展开题库/字体
```

再用 Xcode 打开 `ios/App/App.xcworkspace` 装到手机，或沿用现有 `xcodebuild` + `devicectl` 流程。

## Mac

```bash
cd biyi-practice/desktop
npm start
```
