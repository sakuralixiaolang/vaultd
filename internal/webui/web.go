// Package webui 内嵌前端资源，保证单文件分发。
package webui

import "embed"

//go:embed static
var static embed.FS

var (
	IndexHTML []byte
	AppJS     []byte
	StyleCSS  []byte
)

func init() {
	IndexHTML, _ = static.ReadFile("static/index.html")
	AppJS, _ = static.ReadFile("static/app.js")
	StyleCSS, _ = static.ReadFile("static/style.css")
}
