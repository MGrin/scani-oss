import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Textarea } from '@scani/ui/ui/textarea';
import type { RouterOutputs } from '@/lib/trpc';

type CredentialField =
  RouterOutputs['integrations']['listAvailable'][number]['credentialFields'][number];

interface GenericCredentialFormProps {
  fields: readonly CredentialField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
}

/**
 * Renders the manifest's `credentialFields` as labelled inputs. The
 * field array drives the form shape end-to-end — adding a new credential
 * to a provider means a manifest edit, no UI change.
 */
export function GenericCredentialForm({
  fields,
  values,
  onChange,
  disabled,
}: GenericCredentialFormProps) {
  return (
    <>
      {fields.map((field) => {
        const id = `cred-${field.name}`;
        const value = values[field.name] ?? '';
        const label = field.required ? field.label : `${field.label} (optional)`;
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={id}>{label}</Label>
            {field.type === 'textarea' ? (
              <Textarea
                id={id}
                value={value}
                onChange={(e) => onChange(field.name, e.target.value)}
                placeholder={field.placeholder ?? `Enter ${field.label}`}
                disabled={disabled}
                rows={4}
                className="font-mono text-xs"
              />
            ) : (
              <Input
                id={id}
                value={value}
                onChange={(e) => onChange(field.name, e.target.value)}
                placeholder={field.placeholder ?? `Enter ${field.label}`}
                type={field.sensitive ? 'password' : 'text'}
                disabled={disabled}
              />
            )}
            {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
          </div>
        );
      })}
    </>
  );
}
