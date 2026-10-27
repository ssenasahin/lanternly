import { Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { useFieldArray, useWatch, type UseFormReturn } from "react-hook-form";
import { Segmented, TextField } from "../../components";
import { OPERATORS, PRESENCE } from "./operators";
import { NEW_HEADER, NEW_RULE, sendsBody, type MonitorForm } from "./schema";

const BODY_TYPES = [
  { value: "NONE", label: "No body" },
  { value: "JSON", label: "JSON" },
  { value: "FORM", label: "Form" },
] as const;

type Form = UseFormReturn<MonitorForm>;

// Headers and body: what the API monitor sends besides its method and URL.
export function RequestFields({ form }: { form: Form }) {
  const { control, register, setValue } = form;
  const errors = form.formState.errors;
  const headers = useFieldArray({ control, name: "headers" });
  const [method, bodyType, rows] = useWatch({
    control,
    name: ["method", "bodyType", "headers"],
  });
  const canSend = method !== "GET" && method !== "HEAD";

  return (
    <>
      <fieldset className="field">
        <legend className="field-label">Headers</legend>
        {headers.fields.length > 0 && (
          <div className="row-list">
            {headers.fields.map((field, i) => {
              const row = rows[i];
              const secret = row?.secret ?? false;
              // A saved secret is never sent back, so its box starts empty.
              const kept = secret && row?.stored;
              return (
                <div key={field.id} className="row-item header-row">
                  <TextField
                    label="Name"
                    placeholder="Authorization"
                    autoComplete="off"
                    spellCheck={false}
                    mono
                    error={errors.headers?.[i]?.name?.message}
                    {...register(`headers.${i}.name`)}
                  />
                  <TextField
                    label="Value"
                    type={secret ? "password" : "text"}
                    placeholder={kept ? "Saved. Leave blank to keep it" : "Bearer …"}
                    autoComplete="off"
                    spellCheck={false}
                    mono
                    error={errors.headers?.[i]?.value?.message}
                    {...register(`headers.${i}.value`)}
                  />
                  <button
                    type="button"
                    className={`btn btn-ghost btn-icon row-action${secret ? " is-on" : ""}`}
                    aria-pressed={secret}
                    title={secret ? "Secret: hidden after saving" : "Mark as secret"}
                    onClick={() => setValue(`headers.${i}.secret`, !secret, { shouldDirty: true })}
                  >
                    {secret ? <Lock size={15} aria-hidden /> : <LockOpen size={15} aria-hidden />}
                    <span className="sr-only">Secret</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon row-action"
                    title="Remove header"
                    onClick={() => headers.remove(i)}
                  >
                    <Trash2 size={15} aria-hidden />
                    <span className="sr-only">Remove header</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => headers.append({ ...NEW_HEADER })}
            disabled={headers.fields.length >= 20}
          >
            <Plus size={14} aria-hidden /> Add header
          </button>
        </div>
        <span className="field-hint">
          Lock a header that carries a key or token: it's stored encrypted and never shown again.
        </span>
      </fieldset>

      {canSend && (
        <fieldset className="field">
          <legend className="field-label">Body</legend>
          <Segmented
            label="Body type"
            options={BODY_TYPES}
            value={bodyType}
            onChange={(v) => setValue("bodyType", v, { shouldDirty: true })}
            small
          />
          {sendsBody({ method, bodyType }) && (
            <>
              <textarea
                className="input input-mono textarea"
                rows={5}
                spellCheck={false}
                placeholder={bodyType === "JSON" ? '{ "probe": true }' : "probe=true&region=eu"}
                aria-label="Request body"
                aria-invalid={errors.body ? true : undefined}
                {...register("body")}
              />
              {errors.body && <span className="field-error">{errors.body.message}</span>}
            </>
          )}
        </fieldset>
      )}
    </>
  );
}

// What the answer must look like: a status code from the list, and every rule true of
// its JSON.
export function ResponseFields({ form }: { form: Form }) {
  const { control, register } = form;
  const errors = form.formState.errors;
  const rules = useFieldArray({ control, name: "rules" });
  const operators = useWatch({ control, name: "rules" }).map((r) => r.operator);

  return (
    <>
      <TextField
        label="Expected status codes"
        placeholder="200-299"
        autoComplete="off"
        spellCheck={false}
        mono
        hint="A code, a range, 2xx, or a list like 200, 304. Redirects aren't followed."
        error={errors.expectedStatus?.message}
        {...register("expectedStatus")}
      />

      <fieldset className="field">
        <legend className="field-label">Rules</legend>
        {rules.fields.length > 0 && (
          <div className="row-list">
            {rules.fields.map((field, i) => {
              const presence = PRESENCE.has(operators[i] ?? "EQUALS");
              return (
                <div key={field.id} className="row-item rule-row">
                  <TextField
                    label="Path"
                    placeholder="data.items[0].price"
                    autoComplete="off"
                    spellCheck={false}
                    mono
                    error={errors.rules?.[i]?.path?.message}
                    {...register(`rules.${i}.path`)}
                  />
                  <div className="field">
                    <label className="field-label" htmlFor={`rule-${field.id}-op`}>
                      Check
                    </label>
                    <select
                      id={`rule-${field.id}-op`}
                      className="input select"
                      {...register(`rules.${i}.operator`)}
                    >
                      {OPERATORS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {presence ? (
                    <div className="field rule-no-value" aria-hidden />
                  ) : (
                    <TextField
                      label="Value"
                      placeholder="ok"
                      autoComplete="off"
                      spellCheck={false}
                      mono
                      error={errors.rules?.[i]?.expected?.message}
                      {...register(`rules.${i}.expected`)}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon row-action"
                    title="Remove rule"
                    onClick={() => rules.remove(i)}
                  >
                    <Trash2 size={15} aria-hidden />
                    <span className="sr-only">Remove rule</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => rules.append({ ...NEW_RULE })}
            disabled={rules.fields.length >= 20}
          >
            <Plus size={14} aria-hidden /> Add rule
          </button>
        </div>
        <span className="field-hint">
          Checked against the JSON response, every one of them. A path like{" "}
          <code>data.items[0].price</code> follows keys and list positions. Values are compared as
          typed: <code>42</code> matches the number, <code>true</code> the boolean.
        </span>
        {errors.rules?.message && <span className="field-error">{errors.rules.message}</span>}
      </fieldset>
    </>
  );
}
