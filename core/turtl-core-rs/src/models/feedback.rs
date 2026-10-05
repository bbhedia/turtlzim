use crate::turtl::Turtl;
use crate::error::{TResult, TError};

/// Stores feedback we'll be sending to the server
#[derive(Serialize, Deserialize, Debug)]
pub struct Feedback {
    pub body: String,
}

impl Feedback {
    /// Send feedback back. BO!
    pub async fn send(&self, turtl: &Turtl) -> TResult<()> {
        let logged_in = {
            let user_guard = lockr!(turtl.user);
            user_guard.logged_in
        };
        if !logged_in {
            // nice try
            return TErr!(TError::Msg(String::from("can't send feedback, not logged in")));
        }
        turtl.api.post("/feedback")?
            .json(&self)
            .call::<bool>().await?;
        Ok(())
    }
}

