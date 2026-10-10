# 笔译训练

轻量独立软件：只保留意群中译英及相关配套，原 PTE终结者 工程未改动。

## 网页版（双击启动）

在 Finder 里双击项目根目录的 **`启动网页版.command`**：自动起静态站 + 输入法/朗读/词典代理，并打开浏览器 `http://127.0.0.1:8766/`。重复双击不会重复起服务，只会再开一次页面。要停就在那个终端窗口按 Control-C，或双击 **`停止网页版.command`**。

命令行等价：

```bash
bash scripts/web-launch.sh   # 启动（仅监听 127.0.0.1）
bash scripts/web-stop.sh     # 停止
bash scripts/web-dev.sh      # 老的调试脚本，不带停止/复用逻辑
```

端口：静态站 8766、输入法 8765、朗读 8767、词典 8768。

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
