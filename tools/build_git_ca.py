"""为 git 生成一份包含本机 HTTPS 拦截证书的 CA 包。

背景：本机的 HTTPS 流量被本地加速工具（Steam++ / Watt Toolkit，证书签发者
"SteamTools Certificate" / BeyondDimension）拦截，它给所有站点签自己的证书。
浏览器和 Python 走 Windows 证书store所以正常，但 git 用的是自带的 Mozilla
CA 包，不信任这张证书，于是 git 报 "unable to get local issuer certificate"。

做法：把拦截工具的根证书从 Windows 证书store里取出来，追加到 git 自带
CA 包的副本后面，生成 _build_tmp/git-ca-bundle.crt，再让本仓库的 git 使用它。
只影响本仓库，不改系统证书store，也不关闭证书校验。
"""
import ssl
from pathlib import Path

from cryptography import x509

GIT_CA = Path(r"D:\Git\mingw64\etc\ssl\certs\ca-bundle.crt")
OUT = Path(r"D:\secondhandshop\_build_tmp\git-ca-bundle.crt")

KEYWORDS = ("SteamTools", "BeyondDimension", "Steam++", "Watt Toolkit")


def main() -> int:
    if not GIT_CA.exists():
        print(f"[FAIL] 找不到 git 的 CA 包：{GIT_CA}")
        return 1

    hits = []
    for der, encoding, trust in ssl.enum_certificates("ROOT"):
        if encoding != "x509_asn":
            continue
        try:
            cert = x509.load_der_x509_certificate(der)
        except Exception:  # noqa: BLE001
            continue
        subject = cert.subject.rfc4514_string()
        if any(k in subject for k in KEYWORDS):
            hits.append((subject, der, trust))

    if not hits:
        print("没在「受信任的根证书」里找到拦截工具的证书。")
        print("可能有别的中间人证书，请把下面这段结果发我，我来判断该信任哪张：")
        for der, encoding, trust in ssl.enum_certificates("ROOT"):
            if encoding != "x509_asn":
                continue
            try:
                cert = x509.load_der_x509_certificate(der)
            except Exception:  # noqa: BLE001
                continue
            subject = cert.subject.rfc4514_string()
            if cert.not_valid_before_utc.year >= 2020 and "Windows" not in subject:
                print("   ", subject)
        return 2

    OUT.parent.mkdir(parents=True, exist_ok=True)
    bundle = GIT_CA.read_text(encoding="utf-8", errors="replace")
    if not bundle.endswith("\n"):
        bundle += "\n"

    for subject, der, trust in hits:
        pem = ssl.DER_cert_to_PEM_cert(der)
        bundle += f"\n# ---- 本机 HTTPS 拦截证书：{subject} ----\n{pem}"
        print(f"[OK]  已加入：{subject}")
        print(f"      信任标志：{trust}")

    OUT.write_text(bundle, encoding="utf-8")
    print(f"[OK]  已生成 CA 包：{OUT}  ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
