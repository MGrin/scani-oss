import { SUGGESTED_CATEGORY_KEYS } from '@scani/shared';
import { showError } from '@scani/ui/ui/use-toast';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { CategoryPicker } from './CategoryPicker';

/** `CategoryPicker` wired to the person's categories, creating and suggesting through the API (SC-1652). */
export function CategoryPickerQuery({
  name,
  value,
  onChange,
  allowClear,
}: {
  name: string;
  value: string | null;
  onChange: (id: string | null) => void;
  allowClear?: boolean;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const list = trpc.categories.list.useQuery();
  const refresh = () => utils.categories.list.invalidate();
  const create = trpc.categories.create.useMutation({
    onSuccess: async ({ id }) => {
      await refresh();
      onChange(id);
    },
    onError: (error) => showError(error),
  });
  const suggest = trpc.categories.suggest.useMutation({
    onSuccess: refresh,
    onError: (error) => showError(error),
  });

  return (
    <CategoryPicker
      name={name}
      nodes={list.data ?? []}
      value={value}
      onChange={onChange}
      allowClear={allowClear}
      busy={create.isPending || suggest.isPending || list.isLoading}
      onCreate={(categoryName) => create.mutate({ name: categoryName })}
      onSuggest={() =>
        suggest.mutate({
          names: Object.fromEntries(
            SUGGESTED_CATEGORY_KEYS.map((key) => [key, t(`v3.categories.suggested.${key}`)])
          ),
        })
      }
    />
  );
}
