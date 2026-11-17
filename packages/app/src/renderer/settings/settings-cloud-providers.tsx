import { unsupportedCloudProvider, type CloudConfigDraft } from "../../shared/cloud-backup.ts";
import type { CosCloudConfigDraft } from "../../shared/cloud-providers/cos.ts";
import { useLocale } from "../locale.tsx";
import { SettingsSecretInput } from "./settings-secret-input.tsx";

type Props = { config: CloudConfigDraft; disabled: boolean; onChange(config: CloudConfigDraft): void };

/** Provider forms own their fields; the settings page owns save/jobs/cloud copies. */
export function CloudProviderFields(props: Props): React.JSX.Element | null {
	const config = props.config;
	const provider = config.provider;
	switch (provider) {
		case "none": return null;
		case "cos": return <CosFields {...props} config={config} />;
		default: return unsupportedCloudProvider(provider);
	}
}

function CosFields({ config, disabled, onChange }: Omit<Props, "config"> & { config: CosCloudConfigDraft }): React.JSX.Element {
	const { t } = useLocale(); const text = t.settings.cloud;
	function patch(values: Partial<CosCloudConfigDraft>) { onChange({ ...config, ...values }); }
	function credential(key: "secretId" | "secretKey", value: string) {
		patch({ credentials: { secretId: "", secretKey: "", ...config.credentials, [key]: value } });
	}
	return <>
		<label>{text.cos.bucket}<input value={config.bucket} placeholder="my-loom-1250000000" disabled={disabled} onChange={(event) => patch({ bucket: event.target.value })} /></label>
		<label>{text.cos.region}<input value={config.region} placeholder="ap-shanghai" disabled={disabled} onChange={(event) => patch({ region: event.target.value })} /></label>
		<label>SecretId<SettingsSecretInput label="SecretId" value={config.credentials?.secretId ?? ""} placeholder="SecretId" disabled={disabled} autoComplete="off" onChange={(event) => credential("secretId", event.target.value)} /></label>
		<label>SecretKey<SettingsSecretInput label="SecretKey" value={config.credentials?.secretKey ?? ""} placeholder="SecretKey" disabled={disabled} autoComplete="off" onChange={(event) => credential("secretKey", event.target.value)} /></label>
		<p className="cloud-field-help">{text.cos.note}</p>
	</>;
}
