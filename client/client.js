// DSH web client module for the llm-verifier plugin settings card.
// Hand-written against the host's client module contract (see dshmarket/client/client.js
// for the reference pattern): one __ModuleLoader__ factory, React via host require,
// card registered into the `settings.plugin.item` slot keyed by the settings namespace.
window.__ModuleLoader__.load({ id: "dsh-llm-verifier", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	let react = require("react");

	const NS = "llm-verifier";
	const name = "llm-verifier";
	const inject = ["slots", "settingsScope"];

	const REVIEW_MODES = [
		["parent_agent", "当前主代理评审"],
		["dsh_model", "指定 DSH 模型评审"],
		["deepseek_verifier", "DeepSeek Verifier (logprobs)"],
	];

	function apply(ctx) {
		ctx.inject(["settingsScope"], (scoped) => {
			const scope = scoped.settingsScope.bind({ namespace: NS });
			scoped.slots.inject("settings.plugin.item", () => scoped.slots.register({
				name: "settings.plugin.item",
				key: NS,
				inject: () => ({})
			}, () => react.createElement(SettingsCard, { scope })));
		});
	}

	function field(labelText, overridden, control) {
		return react.createElement(
			"label",
			{ key: labelText, style: { display: "flex", alignItems: "center", gap: 8, margin: "6px 0" } },
			react.createElement("span", { style: { minWidth: 140 } }, labelText + (overridden ? " *" : "")),
			control
		);
	}

	function SettingsCard({ scope }) {
		const [snap, setSnap] = react.useState(() => scope.getSnapshot());
		react.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
		const [error, setError] = react.useState(null);
		const set = async (field, value) => {
			try {
				setError(null);
				await scope.set(field, value);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		if (snap.status === "loading") {
			return react.createElement("div", { style: styles.root }, "读取中…");
		}
		if (snap.status !== "ready" || snap.value === undefined) {
			return react.createElement("div", { style: styles.root }, "设置命名空间在此实例上不可用。");
		}
		const v = snap.value;
		const user = snap.user ?? {};
		const isOverridden = (key) => Object.prototype.hasOwnProperty.call(user, key);
		return react.createElement(
			"div",
			{ style: styles.root },
			react.createElement("div", { style: styles.title }, "LLM Verifier · 多候选验证与评审"),
			react.createElement(
				"div",
				{ style: styles.hint },
				"带 * 的字段为用户自定义值；修改保存后，下次运行生效，进行中的任务使用启动时的配置。"
			),
			field("启用多候选工具", isOverridden("enabled"),
				react.createElement("input", {
					type: "checkbox",
					checked: v.enabled === true,
					onChange: (event) => void set("enabled", event.target.checked)
				})
			),
			field("答案数量 (1–5)", isOverridden("defaultCandidateCount"),
				react.createElement("input", {
					type: "number", min: 1, max: 5, value: v.defaultCandidateCount,
					style: styles.number,
					onChange: (event) => {
						const parsed = Number.parseInt(event.target.value, 10);
						if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) void set("defaultCandidateCount", parsed);
					}
				})
			),
			field("同时运行 (1–5)", isOverridden("maxConcurrentCandidates"),
				react.createElement("input", {
					type: "number", min: 1, max: 5, value: v.maxConcurrentCandidates,
					style: styles.number,
					onChange: (event) => {
						const parsed = Number.parseInt(event.target.value, 10);
						if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) void set("maxConcurrentCandidates", parsed);
					}
				})
			),
			field("评审方式", isOverridden("reviewMode"),
				react.createElement(
					"select",
					{ value: v.reviewMode, onChange: (event) => void set("reviewMode", event.target.value) },
					REVIEW_MODES.map(([value, label]) => react.createElement("option", { key: value, value }, label))
				)
			),
			error === null
				? null
				: react.createElement("div", { style: styles.error, role: "alert" }, "保存失败：" + error),
			react.createElement(
				"div",
				{ style: styles.status },
				(snap.writable ? "已连接宿主设置文档" : "此实例的设置文档不可写") +
				" · revision " + (snap.revision ?? "-") +
				" · 生效时机：下次运行"
			)
		);
	}

	const styles = {
		root: { display: "flex", flexDirection: "column", gap: 4, padding: "4px 0" },
		title: { fontWeight: 600 },
		hint: { opacity: 0.7, fontSize: 12, marginBottom: 6 },
		number: { width: 72 },
		error: { color: "var(--dsh-danger, #b42318)", fontSize: 12, margin: "4px 0" },
		status: { opacity: 0.6, fontSize: 12, marginTop: 6 }
	};

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
} });
