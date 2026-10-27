import { useWatch, type UseFormReturn } from "react-hook-form";
import type { RecordType } from "../../api/monitors";
import { SelectField, TextField } from "../../components";
import { RECORD_TYPES, type MonitorForm } from "./schema";

// What each record type holds, and an answer to expect, as a hint.
const RECORDS: Record<RecordType, { label: string; example: string }> = {
  A: { label: "A: IPv4 address", example: "93.184.215.14" },
  AAAA: { label: "AAAA: IPv6 address", example: "2606:4700:4700::1111" },
  CNAME: { label: "CNAME: alias for another name", example: "example.netlify.app" },
  MX: { label: "MX: mail server", example: "mx1.example.com" },
  TXT: { label: "TXT: text, like SPF or a site verification", example: "v=spf1 include:…" },
};

export function DnsFields({ form }: { form: UseFormReturn<MonitorForm> }) {
  const {
    register,
    control,
    formState: { errors },
  } = form;
  const recordType = useWatch({ control, name: "recordType" });

  return (
    <div className="form-grid form-grid-2">
      <SelectField
        label="Record type"
        error={errors.recordType?.message}
        {...register("recordType")}
      >
        {RECORD_TYPES.map((t) => (
          <option key={t} value={t}>
            {RECORDS[t].label}
          </option>
        ))}
      </SelectField>

      <TextField
        label="DNS server"
        placeholder="1.1.1.1 and 8.8.8.8"
        hint="A public server's IP address. Leave blank for the defaults."
        autoComplete="off"
        spellCheck={false}
        mono
        error={errors.dnsResolver?.message}
        {...register("dnsResolver")}
      />

      <div className="form-grid-full">
        <TextField
          label="Expected value"
          placeholder={RECORDS[recordType].example}
          hint={
            recordType === "MX"
              ? "Down unless this mail server is among the answers. Leave blank to accept any."
              : "Down unless this is among the answers. Leave blank to accept any."
          }
          autoComplete="off"
          spellCheck={false}
          mono
          error={errors.dnsExpected?.message}
          {...register("dnsExpected")}
        />
      </div>
    </div>
  );
}
