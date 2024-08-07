import UseSWRComponent from "use-swr-component";
import { TotalsBlock } from "../TotalsBlock";
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default function TotalsPage() {
  return (
    <UseSWRComponent props={{}} Component={TotalsBlock} refreshInterval={1e3}>
      {<TotalsBlock />}
    </UseSWRComponent>
  );
}
