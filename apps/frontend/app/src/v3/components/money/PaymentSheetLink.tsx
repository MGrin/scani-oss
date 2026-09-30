import { Link, type LinkProps } from 'react-router-dom';
import { usePaymentSheet } from '../../hooks/usePaymentSheet';

/**
 * A link that opens the bill form over the screen it sits on, so closing the
 * form lands back there — on the bill's peek, or on the filtered list (SC-1414).
 * Links from other screens use `V3_PAYMENT_ROUTES`, which open it over Bills.
 */
export function PaymentSheetLink({
  sheet,
  ...rest
}: { sheet: string } & Omit<LinkProps, 'to' | 'state'>) {
  const { linkTo } = usePaymentSheet();
  const { to, state } = linkTo(sheet);
  return <Link to={to} state={state} {...rest} />;
}
