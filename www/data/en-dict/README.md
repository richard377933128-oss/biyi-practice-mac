# 离线英汉词典（ECDICT 精简分片）

来源：[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)（GPL）。

- `*.json.gz`：按首字母分片，词条为 `[音标, 中文释义]`
- `forms.json.gz`：屈折形态 → 原形
- `index.json`：索引

重新生成（需已下载的 sqlite）：

```bash
# 默认读 /tmp/ecdict-build/stardict.db
python3 scripts/build-en-dict.py
```
